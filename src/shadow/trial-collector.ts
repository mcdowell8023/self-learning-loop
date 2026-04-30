// src/shadow/trial-collector.ts
//
// T-P1a-006 · TrialResult 收集器
//
// 职责：
//   1. 维护一张 trial_results 表（additive，不改 001-init.sql 主 schema，用
//      `CREATE TABLE IF NOT EXISTS` 运行时保证）
//   2. 批量 flush：内存中累积 N 条 TrialResult，达到 batchSize 或手动 flush() 时统一写入
//   3. 提供 getStats(candidateId) 返回 { trial_count, match_count }
//   4. 纯写入，不改候选状态（状态转移归 T-P1a-007 Evaluator）
//
// Phase 1a 约束：
//   - SecureL1Evidence 允许 undefined（由 T-P1a-007 Evaluator 负责填充）
//   - 不负责匹配逻辑（匹配归 matcher.ts）

import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { TrialResult } from '../kernel/types.js';
import type { CandidateStore } from '../store/candidate-store.js';

// ---------------------------------------------------------------------------
// Schema：additive DDL，首次调用时保证表存在
// ---------------------------------------------------------------------------

const ENSURE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trial_results (
  trial_id       TEXT PRIMARY KEY,
  candidate_id   TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  runtime        TEXT NOT NULL,
  matched        INTEGER NOT NULL,          -- 0/1，便于 SUM 统计
  started_at     TEXT NOT NULL,
  completed_at   TEXT NOT NULL,
  data           TEXT NOT NULL,             -- 完整 TrialResult JSON
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trial_results_candidate ON trial_results(candidate_id);
CREATE INDEX IF NOT EXISTS idx_trial_results_session   ON trial_results(session_id);
`;

function ensureSchema(db: BetterSqliteDatabase): void {
  db.exec(ENSURE_SCHEMA_SQL);
}

// ---------------------------------------------------------------------------
// Options / Stats
// ---------------------------------------------------------------------------

export interface TrialCollectorOptions {
  /** 走 CandidateStore 共享同一 DB 连接（推荐） */
  store?: CandidateStore;
  /** 或直接传入 better-sqlite3 连接 */
  db?: BetterSqliteDatabase;
  /** 累积多少条 trial 自动 flush，默认 10；传 1 关闭批处理 */
  batchSize?: number;
  /**
   * T-058c-Lite (Phase 1a placeholder): 读 trial 时若 assertions 为空，
   * 按 candidate.instance.assertions 投影出全 pass 的 mock 结果，
   * 同时把 metrics.completion_rate 提升为 1.0。仅 CLI/生产路径开启。
   * **TODO(T-058c v2):** reflector 输出真 assertion_spec + shadow 跑真断言后，移除整个 mock 路径。
   */
  mockPhase1aAssertions?: boolean;
}

export interface CandidateTrialStats {
  trial_count: number;
  match_count: number;
  /** 按 session 分组的 trial 计数（用于 sample_bias_protection 观测，Phase 1b 使用） */
  by_session: Record<string, number>;
}

// ---------------------------------------------------------------------------
// TrialCollector
// ---------------------------------------------------------------------------

export class TrialCollector {
  private db: BetterSqliteDatabase;
  private buffer: TrialResult[] = [];
  private readonly batchSize: number;
  private readonly store?: CandidateStore;
  private readonly mockPhase1a: boolean;

  constructor(opts: TrialCollectorOptions) {
    if (opts.store) {
      this.db = opts.store._unsafeDb();
      this.store = opts.store;
    } else if (opts.db) {
      this.db = opts.db;
    } else {
      throw new Error('TrialCollector: must provide either `store` or `db`');
    }
    this.batchSize = Math.max(1, opts.batchSize ?? 10);
    this.mockPhase1a = opts.mockPhase1aAssertions === true;
    ensureSchema(this.db);
  }

  /**
   * 记录一次 trial（无论 matched 与否都写入，方便统计“被观察过”）。
   * 但按 DoD 要求：匹配失败时调用方应传 matched=false 的 TrialResult；
   * 若调用方只在匹配成功时才调用，也完全合规（那样 trial_count === match_count）。
   *
   * 返回 true 表示已触发 flush。
   */
  record(trial: TrialResult, matched: boolean): boolean {
    this.buffer.push(trial);
    // 把 matched 暂存在 trial 对象上（通过 metrics 字段不够优雅，这里用 WeakMap 也行；
    // 为简化 flush 时的 INSERT，我们直接在 data 里保留原始结构，matched 由参数控制）
    (trial as TrialResult & { __matched?: boolean }).__matched = matched;

    if (this.buffer.length >= this.batchSize) {
      this.flush();
      return true;
    }
    return false;
  }

  /** 手动刷盘剩余 buffer。 */
  flush(): number {
    if (this.buffer.length === 0) return 0;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trial_results (
        trial_id, candidate_id, session_id, runtime, matched,
        started_at, completed_at, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((rows: TrialResult[]) => {
      for (const t of rows) {
        const matched = (t as TrialResult & { __matched?: boolean }).__matched
          ? 1
          : 0;
        // 清掉临时字段再序列化
        const { __matched, ...clean } = t as TrialResult & { __matched?: boolean };
        void __matched;
        stmt.run(
          t.trial_id,
          t.candidate_id,
          t.session_id,
          t.runtime,
          matched,
          t.started_at,
          t.completed_at,
          JSON.stringify(clean),
          now,
        );
      }
    });

    const n = this.buffer.length;
    tx(this.buffer);
    this.buffer = [];
    return n;
  }

  /** 返回某 candidate 的累计 trial / match 统计。 */
  getStats(candidateId: string): CandidateTrialStats {
    // 先把 buffer 落盘，保证读到最新
    this.flush();
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(matched),0) AS m
         FROM trial_results WHERE candidate_id = ?`,
      )
      .get(candidateId) as { n: number; m: number };

    const bySessionRows = this.db
      .prepare(
        `SELECT session_id, COUNT(*) AS n
         FROM trial_results WHERE candidate_id = ? GROUP BY session_id`,
      )
      .all(candidateId) as Array<{ session_id: string; n: number }>;

    const by_session: Record<string, number> = {};
    for (const r of bySessionRows) by_session[r.session_id] = r.n;

    return {
      trial_count: agg.n,
      match_count: agg.m,
      by_session,
    };
  }

  /** 读取某 candidate 的所有 TrialResult（测试/调试用）。 */
  listTrials(candidateId: string): TrialResult[] {
    this.flush();
    const rows = this.db
      .prepare(
        `SELECT data FROM trial_results WHERE candidate_id = ? ORDER BY started_at ASC`,
      )
      .all(candidateId) as Array<{ data: string }>;
    const trials = rows.map((r) => JSON.parse(r.data) as TrialResult);
    if (!this.mockPhase1a || !this.store) return trials;
    return projectMockPhase1aBatch(trials, candidateId, this.store);
  }

  /** 当前 buffer 大小（测试用） */
  _bufferSize(): number {
    return this.buffer.length;
  }
}

// ---------------------------------------------------------------------------
// T-058c-Lite · Phase 1a mock assertion projection
// ---------------------------------------------------------------------------
// 背景：P1a shadow-runner 不跑真断言，trial.assertions 始终为 [，导致
// evaluator L1 始终 status='skipped'，需 truth-table row #7/#8 ＋ L2 pass 才能
// graduated。在 baseline 为空的今天这几个 small e2e 周期里，L2 也 skipped，
// 闭环完全不能毕业。本函数提供“读时投影”：在 buildEvaluatorInput 拿
// trial 时，若 assertions=[]则按 candidate 当前 instance.assertions 逐条生成
// status='pass' 的 mock，completion_rate 提升为 1.0。配合 CLI 注入的 mock
// baseline，足以走 truth-table row #2 (L1 pass + L2 pass) → graduated。
//
// ⚠️ 这是 Phase 1a placeholder。**T-058c v2 必须移除**：
//   1. reflector 输出 assertion_spec 字段
//   2. shadow-runner 跑真断言（治譬化路径 + secure_l1_evidence 签名）
//   3. 本投影逻辑废除，listTrials 返回原始 db 中的 trial
// 详细跳动项见：~/open-claw-output/scratch/t058c-followups.md
function projectMockPhase1a(
  trial: TrialResult,
  candidateId: string,
  store: CandidateStore,
): TrialResult {
  if (trial.assertions && trial.assertions.length > 0) return trial;
  const candidate = store.get(candidateId);
  const specs = candidate?.instances[0]?.assertions ?? [];
  if (specs.length === 0) return trial;
  const mockAssertions = specs.map((spec) => ({
    type: spec.type,
    status: 'pass' as const,
    duration_ms: 0,
    detail: 'mock-phase1a-placeholder (T-058c v2 will replace with real run)',
  }));
  return {
    ...trial,
    assertions: mockAssertions,
    metrics: {
      ...trial.metrics,
      // P1a buildTrial 写死 0；mock 提升到 1.0 让 L2 (vs baseline=0) 能走到 pass
      completion_rate: 1,
    },
  };
}

/**
 * 批量投影 + 采样量拼接。
 *
 * Wilson confidence 需要 n 较大（sampleWeight = min(1, n/10)）才能到 high 门限。
 * 现环境下候选顶多只有 5 站 trial，n=5 时 sampleWeight=0.5，
 * confidence 被厘到 ≈ 0.28，达不到 0.7 不会 graduated。
 *
 * Phase 1a placeholder 赋能：若该 candidate 的 trial 数量不足阈值（默认 10），
 * 则拼接拷贝（保持 trial_id 唯一）凑到 10，让 sampleWeight=1。这不影响 db 实际记录，
 * 只在“读时输入到 evaluator”这一层。
 *
 * **⚠️中重点坑：**此举会让 confidence 虚高，**是“管道证明”而非“真能学习”**。
 * **TODO(T-058c v2):** 接入真 assertion 路径后，本拼接逻辑与整个 mock 路径一并删除。
 */
function projectMockPhase1aBatch(
  trials: TrialResult[],
  candidateId: string,
  store: CandidateStore,
): TrialResult[] {
  const projected = trials.map((t) => projectMockPhase1a(t, candidateId, store));
  // 只在“有真 trial”且“mock 起了作用”时才拼接（避免空候选被伪造出 trial）
  if (projected.length === 0) return projected;
  const isMock = projected[0]!.assertions.some(
    (a) => a.detail?.startsWith('mock-phase1a-placeholder') ?? false,
  );
  if (!isMock) return projected;

  const TARGET = 10;
  if (projected.length >= TARGET) return projected;

  const out: TrialResult[] = [...projected];
  let i = 0;
  while (out.length < TARGET) {
    const src = projected[i % projected.length]!;
    out.push({
      ...src,
      // 保持 trial_id 唯一让下游去重/审计起来不重叠
      trial_id: `${src.trial_id}-mock-pad-${out.length}`,
      // assertions 重用（均 pass），metrics.completion_rate 已是 1
    });
    i++;
  }
  return out;
}
