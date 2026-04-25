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
function ensureSchema(db) {
    db.exec(ENSURE_SCHEMA_SQL);
}
// ---------------------------------------------------------------------------
// TrialCollector
// ---------------------------------------------------------------------------
export class TrialCollector {
    db;
    buffer = [];
    batchSize;
    constructor(opts) {
        if (opts.store) {
            this.db = opts.store._unsafeDb();
        }
        else if (opts.db) {
            this.db = opts.db;
        }
        else {
            throw new Error('TrialCollector: must provide either `store` or `db`');
        }
        this.batchSize = Math.max(1, opts.batchSize ?? 10);
        ensureSchema(this.db);
    }
    /**
     * 记录一次 trial（无论 matched 与否都写入，方便统计“被观察过”）。
     * 但按 DoD 要求：匹配失败时调用方应传 matched=false 的 TrialResult；
     * 若调用方只在匹配成功时才调用，也完全合规（那样 trial_count === match_count）。
     *
     * 返回 true 表示已触发 flush。
     */
    record(trial, matched) {
        this.buffer.push(trial);
        // 把 matched 暂存在 trial 对象上（通过 metrics 字段不够优雅，这里用 WeakMap 也行；
        // 为简化 flush 时的 INSERT，我们直接在 data 里保留原始结构，matched 由参数控制）
        trial.__matched = matched;
        if (this.buffer.length >= this.batchSize) {
            this.flush();
            return true;
        }
        return false;
    }
    /** 手动刷盘剩余 buffer。 */
    flush() {
        if (this.buffer.length === 0)
            return 0;
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO trial_results (
        trial_id, candidate_id, session_id, runtime, matched,
        started_at, completed_at, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const tx = this.db.transaction((rows) => {
            for (const t of rows) {
                const matched = t.__matched
                    ? 1
                    : 0;
                // 清掉临时字段再序列化
                const { __matched, ...clean } = t;
                void __matched;
                stmt.run(t.trial_id, t.candidate_id, t.session_id, t.runtime, matched, t.started_at, t.completed_at, JSON.stringify(clean), now);
            }
        });
        const n = this.buffer.length;
        tx(this.buffer);
        this.buffer = [];
        return n;
    }
    /** 返回某 candidate 的累计 trial / match 统计。 */
    getStats(candidateId) {
        // 先把 buffer 落盘，保证读到最新
        this.flush();
        const agg = this.db
            .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(matched),0) AS m
         FROM trial_results WHERE candidate_id = ?`)
            .get(candidateId);
        const bySessionRows = this.db
            .prepare(`SELECT session_id, COUNT(*) AS n
         FROM trial_results WHERE candidate_id = ? GROUP BY session_id`)
            .all(candidateId);
        const by_session = {};
        for (const r of bySessionRows)
            by_session[r.session_id] = r.n;
        return {
            trial_count: agg.n,
            match_count: agg.m,
            by_session,
        };
    }
    /** 读取某 candidate 的所有 TrialResult（测试/调试用）。 */
    listTrials(candidateId) {
        this.flush();
        const rows = this.db
            .prepare(`SELECT data FROM trial_results WHERE candidate_id = ? ORDER BY started_at ASC`)
            .all(candidateId);
        return rows.map((r) => JSON.parse(r.data));
    }
    /** 当前 buffer 大小（测试用） */
    _bufferSize() {
        return this.buffer.length;
    }
}
