// src/shadow/shadow-runner.ts
//
// T-P1a-006 · Shadow Runner 主实现（被动观察）
//
// 职责：
//   对于每个处于 `validating` 状态的候选，检查传入的 SessionEvent[] 是否匹配其
//   trigger_conditions + scope；匹配则生成一条 TrialResult 交给 TrialCollector
//   批量落盘；不匹配则根据 recordMisses 选项决定是否也记录一条 matched=false
//   的 trial（默认不记录，按 DoD "匹配失败 → 不记录"）。
//
// 严格约束（v5.0.4 §8）：
//   1. **纯被动** — 只读 SessionEvent，不 exec、不调 API、不改文件
//   2. **不改候选状态** — 状态转移是 T-P1a-007 Evaluator 的事
//   3. **状态驱动** — 只处理 validating 状态的候选
//   4. **批处理** — 通过 TrialCollector.batchSize 控制写入频率
//   5. **L1 Evidence placeholder** — Phase 1a 不产生 SecureL1Evidence（undefined）
//
// 调用方式：
//   const runner = new ShadowRunner({ store, collector });
//   const report = runner.observe(sessionId, events, envFingerprint);
//   // report: { candidatesChecked, matched, trialsWritten }
//
// 与 Reflect Generator.trigger 的边界：
//   - Generator.trigger：判断"这个 session 值得产生新候选吗"
//   - ShadowRunner：判断"已有的 validating 候选在这个 session 中应验了吗"
//   两者互不干扰。

import { randomBytes } from 'node:crypto';

import type {
  Candidate,
  EnvFingerprint,
  TrialResult,
} from '../kernel/types.js';
import type { CandidateStore } from '../store/candidate-store.js';
import type { SessionEvent } from '../reflect/reflection-prompt.js';

import {
  DEFAULT_MATCHER_CONFIG,
  matchSession,
  type MatcherConfig,
  type MatchResult,
} from './matcher.js';
import { TrialCollector } from './trial-collector.js';

// ---------------------------------------------------------------------------
// Options / Report
// ---------------------------------------------------------------------------

export interface ShadowRunnerOptions {
  store: CandidateStore;
  /** 可选传入已存在的 collector（测试方便）；不传则 runner 自建一个。 */
  collector?: TrialCollector;
  /** 匹配器配置（覆盖默认） */
  matcherConfig?: Partial<MatcherConfig>;
  /**
   * 是否记录"不匹配"的 trial。
   * 默认 false（按 DoD：匹配失败 → 不记录）。
   * 调试/sample-bias 观测时可打开。
   */
  recordMisses?: boolean;
  /** Trial ID 生成器（测试可 mock） */
  trialIdFactory?: () => string;
}

export interface ObserveReport {
  sessionId: string;
  candidatesChecked: number;
  /** 每个候选的匹配结果（含 skip 原因） */
  perCandidate: Array<{
    candidate_id: string;
    state: string;
    matched: boolean;
    skipped?: string;
    match?: MatchResult;
    trial_id?: string;
  }>;
  matchedCount: number;
  trialsWritten: number;
}

// ---------------------------------------------------------------------------
// ShadowRunner
// ---------------------------------------------------------------------------

export class ShadowRunner {
  private readonly store: CandidateStore;
  private readonly collector: TrialCollector;
  private readonly matcherConfig: MatcherConfig;
  private readonly recordMisses: boolean;
  private readonly trialIdFactory: () => string;

  constructor(opts: ShadowRunnerOptions) {
    this.store = opts.store;
    this.collector =
      opts.collector ?? new TrialCollector({ store: opts.store });
    this.matcherConfig = { ...DEFAULT_MATCHER_CONFIG, ...(opts.matcherConfig ?? {}) };
    this.recordMisses = opts.recordMisses ?? false;
    this.trialIdFactory = opts.trialIdFactory ?? defaultTrialId;
  }

  /**
   * 被动观察一个 session：对所有 validating 候选跑匹配，记录 trial。
   *
   * @param sessionId  会话唯一 ID（由 Adapter 提供）
   * @param events     该 session 的 SessionEvent 列表（完整或批次）
   * @param env        该 session 的 env_fingerprint（用于 trial 记录）
   */
  observe(
    sessionId: string,
    events: SessionEvent[],
    env: EnvFingerprint,
  ): ObserveReport {
    const startedAt = new Date().toISOString();
    const candidates = this.store.list({ state: 'validating' });

    const report: ObserveReport = {
      sessionId,
      candidatesChecked: candidates.length,
      perCandidate: [],
      matchedCount: 0,
      trialsWritten: 0,
    };

    for (const c of candidates) {
      // 双重保险：虽然 list 已经按 state 过滤了，再校验一次避免并发变更
      if (c.state !== 'validating') {
        report.perCandidate.push({
          candidate_id: c.candidate_id,
          state: c.state,
          matched: false,
          skipped: `state=${c.state}, only 'validating' is observed`,
        });
        continue;
      }

      const match = matchSession(c.strategy, events, this.matcherConfig);
      const completedAt = new Date().toISOString();

      if (!match.matched && !this.recordMisses) {
        // 默认路径：不记录 miss
        report.perCandidate.push({
          candidate_id: c.candidate_id,
          state: c.state,
          matched: false,
          match,
        });
        continue;
      }

      const trial = this.buildTrial({
        candidate: c,
        sessionId,
        events,
        env,
        startedAt,
        completedAt,
        match,
      });

      this.collector.record(trial, match.matched);
      report.trialsWritten += 1;
      if (match.matched) report.matchedCount += 1;

      report.perCandidate.push({
        candidate_id: c.candidate_id,
        state: c.state,
        matched: match.matched,
        match,
        trial_id: trial.trial_id,
      });
    }

    return report;
  }

  /** 手动刷盘 TrialCollector 的 buffer。 */
  flush(): number {
    return this.collector.flush();
  }

  /** 暴露 collector 用于统计查询。 */
  getCollector(): TrialCollector {
    return this.collector;
  }

  // -------------------------------------------------------------------------
  // 内部：构造 TrialResult
  // -------------------------------------------------------------------------

  private buildTrial(args: {
    candidate: Candidate;
    sessionId: string;
    events: SessionEvent[];
    env: EnvFingerprint;
    startedAt: string;
    completedAt: string;
    match: MatchResult;
  }): TrialResult {
    const { candidate, sessionId, events, env, startedAt, completedAt, match } = args;

    // 基础 metrics：从 events 粗统计（Phase 1a 简化版；T-P1a-007 会有更精细版本）
    const turns = events.filter(
      (e) => e.type === 'user_message' || e.type === 'assistant_message',
    ).length;
    const errors = events.filter((e) => e.type === 'error').length;
    const tokenUsage = events.reduce((sum, e) => {
      const t = (e.metadata?.token_usage as number | undefined) ?? 0;
      return sum + (typeof t === 'number' ? t : 0);
    }, 0);

    return {
      trial_id: this.trialIdFactory(),
      candidate_id: candidate.candidate_id,
      session_id: sessionId,
      runtime: env.runtime,
      started_at: startedAt,
      completed_at: completedAt,
      // Phase 1a：Shadow 不评估 assertion，仅记录"被观察到"。
      // 真正的 assertion 跑由 T-P1a-007 Evaluator（L1）负责。
      assertions: candidate.strategy ? [] : [],
      metrics: {
        turns,
        errors,
        token_usage: tokenUsage,
        // completion_rate：Phase 1a 无判定，填 0；T-P1a-007 会覆盖
        completion_rate: 0,
      },
      env_fingerprint: env,
      // SecureL1Evidence 由 Evaluator 在沙箱执行 L1 后填充；
      // Shadow 被动观察阶段永远不填（nothing to sign）
      secure_l1_evidence: undefined,
      // 匹配调试信息放 metadata 不合规（TrialResult 没有该字段），
      // 但可通过 listTrials 结合 match report 查询；这里不挂载。
    };
  }
}

// ---------------------------------------------------------------------------
// 工具：默认 trial_id 生成器
// ---------------------------------------------------------------------------

function defaultTrialId(): string {
  // trial-<unix-ms>-<6hex>，可读且唯一性足够
  return `trial-${Date.now()}-${randomBytes(3).toString('hex')}`;
}
