// src/kernel/types.ts
//
// Phase 1a 运行时平铺接口（下游 store/review/reflect/shadow 使用）。
// 完整 zod schemas 见 ./schemas/*.ts（T-P1a-001 合并后引入）。
//
// 本文件提供两类导出：
// 1. 原有平铺 interface（Candidate/Strategy/Instance/TrialResult/...）——B 侧下游契约
// 2. 从 ./schemas/ re-export 的新增类型（SessionEvent/SessionRef/AuditEvent/...）
//
// 注意：schemas 里的 `type Candidate`（z.infer，嵌套 data 结构）**不**在本文件 re-export，
// 避免与平铺 Candidate 命名冲突。需要 zod 校验请直接 `from '../kernel/schemas/...'`。

export type CandidateScope =
  | 'general'
  | `tool:${string}`
  | `role:${string}`
  | 'skill';

/** §5.2.1 八态状态机 */
export type CandidateState =
  | 'pending'
  | 'reviewing'
  | 'validating'
  | 'conflict'
  | 'graduated'
  | 'retired'
  | 'dormant'
  | 'rejected';

/** dormant 的两种语义（§5.2.1 v5.0.3） */
export type DormantReason = 'no_match' | 'inconclusive';

/** §4.1.4 EnvFingerprint（v5.0.1 修订：extensions 隔离） */
export interface EnvFingerprint {
  runtime: string;
  platform: 'linux' | 'darwin' | 'win32';
  arch: 'x64' | 'arm64';
  runtimeVersion?: string;
  model?: string;
  nodeVersion?: string;
  extensions?: Record<string, unknown>;
}

/** §5.1.5 assertions 条目（Phase 1a 最小结构；T-P1a-004/007 扩展） */
export interface AssertionSpec {
  type: string;
  description?: string;
  command?: string;
  expected_exit_code?: number;
  command_allowlist?: string[];
  timeout_ms?: number;
  sandbox_profile?: string;
  [extra: string]: unknown;
}

/** §5.5.1 SecureL1Evidence（v5.0.2） */
export interface SecureL1Evidence {
  sandbox_type: 'bwrap' | 'firejail' | 'docker';
  exit_code_verified: boolean;
  execution_trace_hash: string;
  timestamp: string;
}

/** §5.5.1 TrialResult */
export interface TrialResult {
  trial_id: string;
  candidate_id: string;
  session_id: string;
  runtime: string;
  started_at: string;
  completed_at: string;
  assertions: Array<{
    type: string;
    status: 'pass' | 'fail' | 'timeout' | 'error' | 'skipped';
    duration_ms: number;
    detail?: string;
  }>;
  metrics: {
    turns: number;
    errors: number;
    token_usage: number;
    completion_rate: number;
  };
  env_fingerprint: EnvFingerprint;
  secure_l1_evidence?: SecureL1Evidence;
}

/**
 * ─── Re-exports from ./schemas ──────────────────────
 * 新增类型（SessionEvent / SessionRef / AuditEvent / EvaluationVerdict / ...）
 * 通过此入口导出，保持 `import ... from '../kernel/types.js'` 一致性。
 */
export type {
  SessionEvent,
  SessionRef,
} from './schemas/session.js';
export type { AuditEvent } from './schemas/audit.js';
export type {
  AssertionStatus,
  AssertionResult,
  TrialMetrics,
} from './schemas/trial.js';
export type {
  VerdictName,
  LayerStatus,
  LayerResult,
  EvaluationVerdict,
} from './schemas/verdict.js';
export type { LearnConfig } from './schemas/config.js';

/** Trigger event metadata (冗余在候选中，供日报展示) */
export interface TriggerEventMeta {
  id?: string;
  summary: string;
}

/** §5.1.2 Strategy Schema */
export interface Strategy {
  strategy_id: string;
  problem_category: string;
  trigger_conditions: string;
  recommended_action: string;
  scope: CandidateScope;
  tags?: string[];
  /** 1-2 句人话总结（v1.1.0-alpha.4+） */
  summary?: string;
  /** 触发事件元信息（v1.1.0-alpha.4+） */
  trigger_event?: TriggerEventMeta;
  created_at: string;
  instance_ids: string[];
}

/** §5.1.3 Instance Schema */
export interface Instance {
  instance_id: string;
  strategy_id: string;
  diff_summary: string;
  files_touched: string[];
  env_fingerprint: EnvFingerprint;
  source_sessions: Array<{
    session_id: string;
    runtime: string;
    timestamp: string;
  }>;
  assertions: AssertionSpec[];
  trial_results: TrialResult[];
  created_at: string;
}

/**
 * Candidate = Strategy + 关联 Instance 的运行时视图 + 生命周期状态。
 *
 * 在 Store 中，Strategy 和 Instance 分开存储（两表设计，§5.2.4），
 * 但对外暴露的 Candidate 视图聚合 Strategy + 其所有 Instance + state。
 *
 * 注意：candidate_id === strategy_id（一个 Strategy 对应一个 Candidate 生命周期）。
 * 多个 Instance 共享同一 Candidate 生命周期（§5.1.1 双层设计）。
 */
export interface Candidate {
  candidate_id: string;        // 与 strategy_id 相同
  strategy: Strategy;
  instances: Instance[];
  state: CandidateState;
  dormant_reason?: DormantReason | null;
  created_at: string;
  updated_at: string;
}
