// src/reflect/candidate-generator.ts
//
// Candidate Generator / Reflection Engine（T-P1a-005）
//
// 职责：
//   1. 输入 SessionEvent[] + EnvFingerprint + 既有 Strategy 摘要
//   2. evaluateTrigger 判断是否该反思
//   3. 构造 Prompt，调 LLMClient 获取候选 JSON
//   4. 解析并校验 JSON（schema + confidence 阈值）
//   5. 生成 Strategy + Instance（通过 content-id.ts 计算 ID）
//   6. 写入 CandidateStore（state=pending）
//
// 对齐 v5.0.3 §5.3 / §7，及 ticket DoD：
//   - 每次反思 0-3 条（超过截断）
//   - confidence < 0.3 丢弃
//   - scope 必须标注，否则丢弃
//   - LLM 调用失败 / JSON 解析失败：返回空数组，不抛错（可审计）

import { computeInstanceId, computeStrategyId } from '../kernel/content-id.js';
import type {
  AssertionSpec,
  CandidateScope,
  EnvFingerprint,
  Instance,
  Strategy,
  TriggerEventMeta,
} from '../kernel/types.js';
import type { CandidateStore } from '../store/candidate-store.js';
import { titleForCandidate } from '../reports/daily-report-generator.js';
import type { LLMClient, LLMCompleteOptions } from './llm-client.js';
import {
  buildReflectPrompt,
  type SessionEvent,
} from './reflection-prompt.js';
import {
  DEFAULT_TRIGGER_CONFIG,
  evaluateTrigger,
  type TriggerConfig,
  type TriggerDecision,
} from './trigger.js';

// ---------------------------------------------------------------------------
// 配置 / 输入输出
// ---------------------------------------------------------------------------

export interface GeneratorConfig {
  /** LLM 调用选项 */
  llmOptions?: LLMCompleteOptions;
  /** 最低置信度阈值，低于则丢弃（默认 0.3，对齐 §5.3.3） */
  minConfidence: number;
  /** 每次反思最多产出数（默认 3，对齐 §5.3.3） */
  maxCandidatesPerReflect: number;
  /** 触发器配置覆盖 */
  triggerConfig?: Partial<TriggerConfig>;
  /** Prompt 模板（覆盖默认） */
  promptTemplate?: string;
  /** 事件截断 / 最大事件数 */
  eventContentTruncate?: number;
  maxEvents?: number;
  /** 允许的 scope 正则集合（默认与 Review Gate 一致） */
  allowedScopePatterns: RegExp[];
}

export const DEFAULT_GENERATOR_CONFIG: GeneratorConfig = {
  llmOptions: { temperature: 0.2, json: true, timeoutMs: 60_000 },
  minConfidence: 0.3,
  maxCandidatesPerReflect: 3,
  triggerConfig: DEFAULT_TRIGGER_CONFIG,
  eventContentTruncate: 500,
  maxEvents: 50,
  allowedScopePatterns: [
    /^general$/,
    /^skill$/,
    /^tool:[a-zA-Z0-9_.\-]+$/,
    /^role:[a-zA-Z0-9_.\-]+$/,
  ],
};

export interface ReflectInput {
  events: SessionEvent[];
  env: EnvFingerprint;
  /** 来源 session（用于 Instance.source_sessions） */
  sessionId: string;
  /** 上次反思时间（触发器判断用） */
  lastReflectAt?: string | Date | null;
  /** 既有 Strategy 摘要（Prompt 去重提示） */
  existingStrategies?: string[];
  /** 已知 problem_category（Prompt 复用分类） */
  problemCategories?: string[];
  /** 强制触发（跳过触发器） */
  manual?: boolean;
  /** 当前时间（测试注入） */
  now?: Date;
}

export interface GeneratedCandidate {
  strategy: Strategy;
  instance: Instance;
  confidence: number;
  rationale?: string;
  raw: RawCandidateJSON;
}

export type DroppedReason = 'duplicate' | 'low_confidence' | 'low_signal' | 'schema_invalid' | 'other';

export interface DroppedItem {
  reason: string;
  reason_code: DroppedReason;
  reason_detail?: string;
  candidate_id_attempted?: string;
  raw: unknown;
}

export interface ReflectResult {
  /** 是否触发了反思（false = 触发器未命中或 manual=false 且无证据） */
  triggered: boolean;
  triggerDecision: TriggerDecision;
  /** LLM 返回的原始文本（便于审计） */
  rawResponse?: string;
  /** 通过阈值 + schema 校验的候选 */
  candidates: GeneratedCandidate[];
  /** 被丢弃的项及原因 */
  dropped: DroppedItem[];
  /** 实际写入 Store 的数量 */
  persistedCount: number;
  /** 错误信息（LLM/解析失败时） */
  error?: string;
}

// ---------------------------------------------------------------------------
// LLM 原始输出 schema
// ---------------------------------------------------------------------------

interface RawAssertionJSON {
  type?: string;
  description?: string;
  command?: string;
  expected_exit_code?: number;
  [k: string]: unknown;
}

interface RawCandidateJSON {
  problem_category?: string;
  trigger_conditions?: string;
  recommended_action?: string;
  scope?: string;
  tags?: string[];
  diff_summary?: string;
  files_touched?: string[];
  assertions?: RawAssertionJSON[];
  confidence?: number;
  rationale?: string;
  summary?: string;
  trigger_event?: { id?: string; summary?: string };
  [k: string]: unknown;
}

// ===========================================================================
// CandidateGenerator
// ===========================================================================

export class CandidateGenerator {
  private readonly config: GeneratorConfig;

  constructor(
    private readonly llm: LLMClient,
    private readonly store: CandidateStore,
    config: Partial<GeneratorConfig> = {},
  ) {
    this.config = { ...DEFAULT_GENERATOR_CONFIG, ...config };
  }

  /**
   * 主入口：执行一次反思。
   *
   * 返回 ReflectResult；不抛错（除非调用方误用，如传 null events）。
   */
  async reflect(input: ReflectInput): Promise<ReflectResult> {
    if (!Array.isArray(input.events)) {
      throw new TypeError('reflect(): input.events must be an array');
    }

    const triggerDecision = evaluateTrigger({
      events: input.events,
      lastReflectAt: input.lastReflectAt,
      now: input.now,
      manual: input.manual,
      config: this.config.triggerConfig,
    });

    if (!triggerDecision.shouldReflect) {
      return {
        triggered: false,
        triggerDecision,
        candidates: [],
        dropped: [],
        persistedCount: 0,
      };
    }

    // 1) 构造 Prompt
    const prompt = buildReflectPrompt({
      events: input.events,
      env: input.env,
      existingStrategies: input.existingStrategies,
      problemCategories: input.problemCategories,
      template: this.config.promptTemplate,
      eventContentTruncate: this.config.eventContentTruncate,
      maxEvents: this.config.maxEvents,
    });

    // 2) 调 LLM
    let rawResponse: string;
    try {
      rawResponse = await this.llm.complete(prompt, this.config.llmOptions);
    } catch (err) {
      return {
        triggered: true,
        triggerDecision,
        candidates: [],
        dropped: [],
        persistedCount: 0,
        error: `LLM call failed: ${(err as Error).message}`,
      };
    }

    // 3) 解析 JSON
    const parsed = this.parseResponse(rawResponse);
    if (!parsed.ok) {
      return {
        triggered: true,
        triggerDecision,
        rawResponse,
        candidates: [],
        dropped: [],
        persistedCount: 0,
        error: parsed.error,
      };
    }

    const rawList = parsed.list.slice(0, this.config.maxCandidatesPerReflect);

    // 4) 校验 + 转换
    const nowIso = (input.now ?? new Date()).toISOString();
    const accepted: GeneratedCandidate[] = [];
    const dropped: DroppedItem[] = [];

    for (const raw of rawList) {
      const validation = this.validate(raw);
      if (!validation.ok) {
        dropped.push({
          reason: validation.reason,
          reason_code: this.classifyDropReason(validation.reason),
          raw,
        });
        continue;
      }

      const strategy = this.buildStrategy(raw, nowIso);
      const instance = this.buildInstance(raw, strategy, input, nowIso);
      strategy.instance_ids = [instance.instance_id];

      accepted.push({
        strategy,
        instance,
        confidence: raw.confidence ?? 0,
        rationale: raw.rationale,
        raw,
      });
    }

    // 5) 持久化：state=pending
    let persistedCount = 0;
    for (const c of accepted) {
      try {
        // 若 strategy_id 已存在，跳过（重复检测交给 Review Gate D3 做正式相似度判断，
        // 这里只做 content-id 精确去重）
        if (this.store.get(c.strategy.strategy_id) != null) {
          dropped.push({
            reason: 'duplicate_strategy_id (content-addressable)',
            reason_code: 'duplicate',
            reason_detail: `Strategy ID ${c.strategy.strategy_id} already exists`,
            candidate_id_attempted: c.strategy.strategy_id,
            raw: c.raw,
          });
          continue;
        }
        const title = titleForCandidate({ candidate_id: c.strategy.strategy_id, strategy: c.strategy });
        this.store.create({
          strategy: c.strategy,
          instances: [c.instance],
          initialState: 'pending',
          title,
        });
        persistedCount++;
      } catch (err) {
        dropped.push({
          reason: `store.create failed: ${(err as Error).message}`,
          reason_code: 'other',
          raw: c.raw,
        });
      }
    }

    // 从 accepted 中剔除已被 dropped 的重复项
    const persisted = accepted.filter((c) =>
      !dropped.some(
        (d) =>
          (d.raw as RawCandidateJSON | undefined) === c.raw &&
          (d.reason.startsWith('duplicate_strategy_id') ||
            d.reason.startsWith('store.create failed')),
      ),
    );

    return {
      triggered: true,
      triggerDecision,
      rawResponse,
      candidates: persisted,
      dropped,
      persistedCount,
    };
  }

  // -------------------------------------------------------------------------
  // Classify drop reason into standard codes
  // -------------------------------------------------------------------------

  private classifyDropReason(reason: string): DroppedReason {
    if (reason.includes('confidence')) return 'low_confidence';
    if (reason.includes('duplicate')) return 'duplicate';
    if (reason.includes('missing/empty field') || reason.includes('invalid scope') || reason.includes('not an object')) return 'schema_invalid';
    if (reason.includes('low_signal')) return 'low_signal';
    return 'other';
  }

  // -------------------------------------------------------------------------
  // 解析 LLM 响应
  // -------------------------------------------------------------------------

  private parseResponse(
    text: string,
  ):
    | { ok: true; list: RawCandidateJSON[] }
    | { ok: false; error: string } {
    if (!text || typeof text !== 'string') {
      return { ok: false, error: 'empty or non-string LLM response' };
    }
    const stripped = stripCodeFence(text.trim());
    try {
      const parsed = JSON.parse(stripped);
      // Support both {"candidates": [...]} and plain [...] formats
      if (Array.isArray(parsed)) {
        return { ok: true, list: parsed as RawCandidateJSON[] };
      }
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.candidates)) {
        return { ok: true, list: parsed.candidates as RawCandidateJSON[] };
      }
      return { ok: false, error: 'LLM response is not a JSON array or {candidates: [...]}' };
    } catch (e) {
      return {
        ok: false,
        error: `JSON parse failed: ${(e as Error).message}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // 候选校验
  // -------------------------------------------------------------------------

  private validate(
    raw: RawCandidateJSON,
  ): { ok: true } | { ok: false; reason: string } {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, reason: 'not an object' };
    }
    const required = [
      'problem_category',
      'trigger_conditions',
      'recommended_action',
      'scope',
    ] as const;
    for (const f of required) {
      const v = raw[f];
      if (typeof v !== 'string' || v.trim().length === 0) {
        return { ok: false, reason: `missing/empty field: ${f}` };
      }
    }

    // scope 格式校验
    const scope = raw.scope as string;
    const scopeOk = this.config.allowedScopePatterns.some((r) => r.test(scope));
    if (!scopeOk) {
      return { ok: false, reason: `invalid scope: ${scope}` };
    }

    // confidence 阈值
    const conf =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? raw.confidence
        : 0;
    if (conf < this.config.minConfidence) {
      return {
        ok: false,
        reason: `confidence ${conf} < threshold ${this.config.minConfidence}`,
      };
    }

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 构造 Strategy / Instance
  // -------------------------------------------------------------------------

  private buildStrategy(raw: RawCandidateJSON, nowIso: string): Strategy {
    const core = {
      problem_category: raw.problem_category as string,
      trigger_conditions: raw.trigger_conditions as string,
      recommended_action: raw.recommended_action as string,
    };
    const strategy_id = computeStrategyId(core);

    // Extract summary (v1.1.0-alpha.4)
    const summary = typeof raw.summary === 'string' && raw.summary.trim().length > 0
      ? raw.summary.trim()
      : undefined;

    // Extract trigger_event (v1.1.0-alpha.4)
    let trigger_event: TriggerEventMeta | undefined;
    if (raw.trigger_event && typeof raw.trigger_event === 'object') {
      const te = raw.trigger_event;
      if (typeof te.summary === 'string' && te.summary.trim().length > 0) {
        trigger_event = {
          id: typeof te.id === 'string' ? te.id : undefined,
          summary: te.summary.trim(),
        };
      }
    }

    return {
      strategy_id,
      ...core,
      scope: raw.scope as CandidateScope,
      tags: Array.isArray(raw.tags)
        ? raw.tags.filter((t) => typeof t === 'string')
        : undefined,
      summary,
      trigger_event,
      created_at: nowIso,
      instance_ids: [],
    };
  }

  private buildInstance(
    raw: RawCandidateJSON,
    strategy: Strategy,
    input: ReflectInput,
    nowIso: string,
  ): Instance {
    const diff_summary =
      typeof raw.diff_summary === 'string' && raw.diff_summary.trim().length > 0
        ? raw.diff_summary
        : `(reflected from session ${input.sessionId})`;

    const files_touched = Array.isArray(raw.files_touched)
      ? raw.files_touched.filter((f) => typeof f === 'string')
      : [];

    const assertions: AssertionSpec[] = Array.isArray(raw.assertions)
      ? raw.assertions
          .filter((a): a is RawAssertionJSON => !!a && typeof a === 'object')
          .map((a) => ({
            type: typeof a.type === 'string' ? a.type : 'unspecified',
            description: typeof a.description === 'string' ? a.description : undefined,
            command: typeof a.command === 'string' ? a.command : undefined,
            expected_exit_code:
              typeof a.expected_exit_code === 'number' ? a.expected_exit_code : undefined,
          }))
      : [];

    const instance_id = computeInstanceId({
      strategy_id: strategy.strategy_id,
      diff_summary,
      env_fingerprint: input.env,
    });

    return {
      instance_id,
      strategy_id: strategy.strategy_id,
      diff_summary,
      files_touched,
      env_fingerprint: input.env,
      source_sessions: [
        {
          session_id: input.sessionId,
          runtime: input.env.runtime,
          timestamp: nowIso,
        },
      ],
      assertions,
      trial_results: [],
      created_at: nowIso,
    };
  }
}

// ---------------------------------------------------------------------------
// 工具：剥离 markdown code fence
// ---------------------------------------------------------------------------

function stripCodeFence(s: string): string {
  // ```json ... ``` or ``` ... ```
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) return (fenceMatch[1] ?? '').trim();
  return s;
}
