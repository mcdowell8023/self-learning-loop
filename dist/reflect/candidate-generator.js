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
import { buildReflectPrompt, } from './reflection-prompt.js';
import { DEFAULT_TRIGGER_CONFIG, evaluateTrigger, } from './trigger.js';
export const DEFAULT_GENERATOR_CONFIG = {
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
// ===========================================================================
// CandidateGenerator
// ===========================================================================
export class CandidateGenerator {
    llm;
    store;
    config;
    constructor(llm, store, config = {}) {
        this.llm = llm;
        this.store = store;
        this.config = { ...DEFAULT_GENERATOR_CONFIG, ...config };
    }
    /**
     * 主入口：执行一次反思。
     *
     * 返回 ReflectResult；不抛错（除非调用方误用，如传 null events）。
     */
    async reflect(input) {
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
        let rawResponse;
        try {
            rawResponse = await this.llm.complete(prompt, this.config.llmOptions);
        }
        catch (err) {
            return {
                triggered: true,
                triggerDecision,
                candidates: [],
                dropped: [],
                persistedCount: 0,
                error: `LLM call failed: ${err.message}`,
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
        const accepted = [];
        const dropped = [];
        for (const raw of rawList) {
            const validation = this.validate(raw);
            if (!validation.ok) {
                dropped.push({ reason: validation.reason, raw });
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
                        raw: c.raw,
                    });
                    continue;
                }
                this.store.create({
                    strategy: c.strategy,
                    instances: [c.instance],
                    initialState: 'pending',
                });
                persistedCount++;
            }
            catch (err) {
                dropped.push({
                    reason: `store.create failed: ${err.message}`,
                    raw: c.raw,
                });
            }
        }
        // 从 accepted 中剔除已被 dropped 的重复项
        const persisted = accepted.filter((c) => !dropped.some((d) => d.raw === c.raw &&
            (d.reason.startsWith('duplicate_strategy_id') ||
                d.reason.startsWith('store.create failed'))));
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
    // 解析 LLM 响应
    // -------------------------------------------------------------------------
    parseResponse(text) {
        if (!text || typeof text !== 'string') {
            return { ok: false, error: 'empty or non-string LLM response' };
        }
        const stripped = stripCodeFence(text.trim());
        try {
            const parsed = JSON.parse(stripped);
            if (!Array.isArray(parsed)) {
                return { ok: false, error: 'LLM response is not a JSON array' };
            }
            return { ok: true, list: parsed };
        }
        catch (e) {
            return {
                ok: false,
                error: `JSON parse failed: ${e.message}`,
            };
        }
    }
    // -------------------------------------------------------------------------
    // 候选校验
    // -------------------------------------------------------------------------
    validate(raw) {
        if (!raw || typeof raw !== 'object') {
            return { ok: false, reason: 'not an object' };
        }
        const required = [
            'problem_category',
            'trigger_conditions',
            'recommended_action',
            'scope',
        ];
        for (const f of required) {
            const v = raw[f];
            if (typeof v !== 'string' || v.trim().length === 0) {
                return { ok: false, reason: `missing/empty field: ${f}` };
            }
        }
        // scope 格式校验
        const scope = raw.scope;
        const scopeOk = this.config.allowedScopePatterns.some((r) => r.test(scope));
        if (!scopeOk) {
            return { ok: false, reason: `invalid scope: ${scope}` };
        }
        // confidence 阈值
        const conf = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
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
    buildStrategy(raw, nowIso) {
        const core = {
            problem_category: raw.problem_category,
            trigger_conditions: raw.trigger_conditions,
            recommended_action: raw.recommended_action,
        };
        const strategy_id = computeStrategyId(core);
        return {
            strategy_id,
            ...core,
            scope: raw.scope,
            tags: Array.isArray(raw.tags)
                ? raw.tags.filter((t) => typeof t === 'string')
                : undefined,
            created_at: nowIso,
            instance_ids: [],
        };
    }
    buildInstance(raw, strategy, input, nowIso) {
        const diff_summary = typeof raw.diff_summary === 'string' && raw.diff_summary.trim().length > 0
            ? raw.diff_summary
            : `(reflected from session ${input.sessionId})`;
        const files_touched = Array.isArray(raw.files_touched)
            ? raw.files_touched.filter((f) => typeof f === 'string')
            : [];
        const assertions = Array.isArray(raw.assertions)
            ? raw.assertions
                .filter((a) => !!a && typeof a === 'object')
                .map((a) => ({
                type: typeof a.type === 'string' ? a.type : 'unspecified',
                description: typeof a.description === 'string' ? a.description : undefined,
                command: typeof a.command === 'string' ? a.command : undefined,
                expected_exit_code: typeof a.expected_exit_code === 'number' ? a.expected_exit_code : undefined,
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
function stripCodeFence(s) {
    // ```json ... ``` or ``` ... ```
    const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch)
        return (fenceMatch[1] ?? '').trim();
    return s;
}
