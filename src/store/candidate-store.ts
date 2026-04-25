// src/store/candidate-store.ts
// Candidate Store — SQLite WAL-backed persistence for Strategy + Instance + 8-state lifecycle.
// v5.0.3 §5.2.4 实现。

import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import type {
  Candidate,
  CandidateScope,
  CandidateState,
  DormantReason,
  Instance,
  Strategy,
} from '../kernel/types.js';

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export class IllegalTransitionError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  constructor(
    public readonly candidateId: string,
    public readonly fromState: CandidateState,
    public readonly toState: CandidateState,
    public readonly action: string,
    extra?: string,
  ) {
    super(
      `Illegal transition for candidate ${candidateId}: ` +
        `${fromState} -> ${toState} via "${action}"` +
        (extra ? ` (${extra})` : ''),
    );
    this.name = 'IllegalTransitionError';
  }
}

export class CandidateNotFoundError extends Error {
  readonly code = 'CANDIDATE_NOT_FOUND';
  constructor(public readonly candidateId: string) {
    super(`Candidate not found: ${candidateId}`);
    this.name = 'CandidateNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// §5.2.2 状态转移规则表（14 条，含 10a/10b/11a/11b）
// ---------------------------------------------------------------------------

export type TransitionActor = 'system' | 'user';

export interface TransitionRule {
  id: string;
  from: CandidateState | '*';
  to: CandidateState;
  action: string;
  actor: TransitionActor | 'both';
  /** 源 dormant_reason 必须匹配才允许转移（用于 10a/10b/11a/11b） */
  sourceDormantReason?: DormantReason;
  /** from='*' 时排除的状态（用于 #12/#13） */
  fromExcept?: CandidateState[];
}

export const TRANSITION_RULES: TransitionRule[] = [
  { id: '1',   from: 'pending',    to: 'reviewing',  action: 'start_review',            actor: 'system' },
  { id: '2',   from: 'reviewing',  to: 'validating', action: 'review_passed',           actor: 'system' },
  { id: '3',   from: 'reviewing',  to: 'rejected',   action: 'review_failed',           actor: 'system' },
  { id: '4',   from: 'validating', to: 'graduated',  action: 'graduate',                actor: 'system' },
  { id: '5',   from: 'validating', to: 'retired',    action: 'retire',                  actor: 'system' },
  { id: '6',   from: 'validating', to: 'conflict',   action: 'enter_conflict',          actor: 'system' },
  { id: '7',   from: 'validating', to: 'dormant',    action: 'enter_dormant',           actor: 'system' },
  { id: '8',   from: 'conflict',   to: 'validating', action: 'conflict_resolved',       actor: 'both' },
  { id: '9',   from: 'conflict',   to: 'retired',    action: 'conflict_abandon',        actor: 'both' },
  { id: '10a', from: 'dormant',    to: 'validating', action: 'wake_on_match',           actor: 'system', sourceDormantReason: 'no_match' },
  { id: '10b', from: 'dormant',    to: 'validating', action: 'wake_on_signal',          actor: 'system', sourceDormantReason: 'inconclusive' },
  { id: '11a', from: 'dormant',    to: 'retired',    action: 'retire_no_match_ttl',     actor: 'system', sourceDormantReason: 'no_match' },
  { id: '11b', from: 'dormant',    to: 'retired',    action: 'retire_inconclusive_ttl', actor: 'system', sourceDormantReason: 'inconclusive' },
  { id: '12',  from: '*',          to: 'graduated',  action: 'force_graduate',          actor: 'user', fromExcept: ['graduated', 'rejected'] },
  { id: '13',  from: '*',          to: 'retired',    action: 'force_retire',            actor: 'user', fromExcept: ['retired', 'rejected'] },
  { id: '14a', from: 'reviewing',  to: 'rejected',   action: 'user_reject',             actor: 'user' },
  { id: '14b', from: 'validating', to: 'rejected',   action: 'user_reject',             actor: 'user' },
  { id: '14c', from: 'dormant',    to: 'rejected',   action: 'user_reject',             actor: 'user' },
];

// ---------------------------------------------------------------------------
// Store 选项 / 公共类型
// ---------------------------------------------------------------------------

export interface CandidateStoreOptions {
  /** SQLite 文件路径。传 ':memory:' 使用内存库（仅测试用）。 */
  dbPath: string;
  /** 自定义 migration 目录；默认使用打包内置的 migrations/。 */
  migrationsDir?: string;
  /** 创建时的默认 actor（transition 日志用），默认 'system'。 */
  defaultActor?: TransitionActor;
}

export interface CreateCandidateInput {
  strategy: Strategy;
  /** 可选的初始 Instance（同步创建）。 */
  instances?: Instance[];
  /** 初始状态，默认 'pending'。 */
  initialState?: CandidateState;
  /** 若 initialState='dormant' 必须提供 reason。 */
  dormantReason?: DormantReason | null;
}

export interface ListFilter {
  state?: CandidateState | CandidateState[];
  scope?: CandidateScope | CandidateScope[];
  problemCategory?: string | string[];
  dormantReason?: DormantReason;
  /** 分页 */
  limit?: number;
  offset?: number;
}

export interface TransitionOptions {
  actor?: TransitionActor;
  /** 进入 dormant 时必须提供；其他转移忽略 */
  dormantReason?: DormantReason;
  /** 用于 10a/10b/11a/11b：显式指定期望的源 dormant_reason（不填则从当前状态推断） */
  expectedSourceDormantReason?: DormantReason;
}

// 辅助：寻找 migrations 目录（兼容 ts 源码/打包后）
function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'migrations');
}

// ===========================================================================
// CandidateStore
// ===========================================================================

export class CandidateStore {
  private db: BetterSqliteDatabase;
  private readonly defaultActor: TransitionActor;

  constructor(opts: CandidateStoreOptions) {
    this.defaultActor = opts.defaultActor ?? 'system';

    if (opts.dbPath !== ':memory:') {
      const dir = dirname(opts.dbPath);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(opts.dbPath);
    // WAL + 外键 + 合理 busy timeout（单写者锁行为：写操作序列化）
    this.db.pragma('journal_mode = wal');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');

    this.runMigrations(opts.migrationsDir ?? defaultMigrationsDir());
  }

  private runMigrations(dir: string): void {
    // Run all .sql files in sorted order (001-init.sql, 002-xxx.sql, etc.)
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf-8');
      this.db.exec(sql);
    }
  }

  close(): void {
    this.db.close();
  }

  /** 暴露底层 DB（测试专用）。 */
  _unsafeDb(): BetterSqliteDatabase {
    return this.db;
  }

  /** PRAGMA journal_mode 的实际值（测试用） */
  getJournalMode(): string {
    const row = this.db.pragma('journal_mode', { simple: true });
    return String(row);
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  create(input: CreateCandidateInput): Candidate {
    const now = new Date().toISOString();
    const initialState: CandidateState = input.initialState ?? 'pending';
    const dormantReason =
      initialState === 'dormant'
        ? (input.dormantReason ?? null)
        : null;

    if (initialState === 'dormant' && !dormantReason) {
      throw new Error(
        `Cannot create candidate in 'dormant' state without dormant_reason`,
      );
    }

    const strategy = input.strategy;
    const candidateId = strategy.strategy_id; // 约定：candidate_id === strategy_id

    const tx = this.db.transaction(() => {
      // 1) Strategy
      this.db.prepare(`
        INSERT INTO strategies (
          strategy_id, problem_category, trigger_conditions, recommended_action,
          scope, tags, data, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        strategy.strategy_id,
        strategy.problem_category,
        strategy.trigger_conditions,
        strategy.recommended_action,
        strategy.scope,
        strategy.tags ? JSON.stringify(strategy.tags) : null,
        JSON.stringify(strategy),
        strategy.created_at ?? now,
      );

      // 2) candidate_state
      this.db.prepare(`
        INSERT INTO candidate_state (
          candidate_id, strategy_id, state, dormant_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(candidateId, strategy.strategy_id, initialState, dormantReason, now, now);

      // 3) 初始 transition 日志
      this.db.prepare(`
        INSERT INTO state_transitions (
          candidate_id, from_state, to_state, action, actor, dormant_reason, transitioned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(candidateId, '(init)', initialState, 'create', this.defaultActor, dormantReason, now);

      // 4) instances
      for (const inst of input.instances ?? []) {
        this.insertInstance(inst);
      }
    });

    tx();
    return this.get(candidateId)!;
  }

  private insertInstance(inst: Instance): void {
    this.db.prepare(`
      INSERT INTO instances (
        instance_id, strategy_id, diff_summary, runtime, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      inst.instance_id,
      inst.strategy_id,
      inst.diff_summary,
      inst.env_fingerprint.runtime,
      JSON.stringify(inst),
      inst.created_at ?? new Date().toISOString(),
    );
  }

  /** 为已存在的 Candidate 追加 Instance（会更新 strategy.instance_ids 列表）。 */
  addInstance(candidateId: string, inst: Instance): Candidate {
    const tx = this.db.transaction(() => {
      const stratRow = this.db.prepare(
        `SELECT data FROM strategies WHERE strategy_id = ?`,
      ).get(inst.strategy_id) as { data: string } | undefined;

      if (!stratRow) throw new CandidateNotFoundError(candidateId);

      const strategy = JSON.parse(stratRow.data) as Strategy;
      if (!strategy.instance_ids.includes(inst.instance_id)) {
        strategy.instance_ids = [...strategy.instance_ids, inst.instance_id];
      }

      this.db.prepare(`UPDATE strategies SET data = ? WHERE strategy_id = ?`)
        .run(JSON.stringify(strategy), inst.strategy_id);

      this.insertInstance(inst);
      this.touch(candidateId);
    });
    tx();
    return this.get(candidateId)!;
  }

  get(candidateId: string): Candidate | null {
    const stateRow = this.db.prepare(`
      SELECT candidate_id, strategy_id, state, dormant_reason, created_at, updated_at
      FROM candidate_state WHERE candidate_id = ?
    `).get(candidateId) as
      | {
          candidate_id: string;
          strategy_id: string;
          state: CandidateState;
          dormant_reason: DormantReason | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!stateRow) return null;

    const strategyRow = this.db.prepare(
      `SELECT data FROM strategies WHERE strategy_id = ?`,
    ).get(stateRow.strategy_id) as { data: string } | undefined;
    if (!strategyRow) return null;
    const strategy = JSON.parse(strategyRow.data) as Strategy;

    const instanceRows = this.db.prepare(
      `SELECT data FROM instances WHERE strategy_id = ? ORDER BY created_at ASC`,
    ).all(stateRow.strategy_id) as Array<{ data: string }>;
    const instances = instanceRows.map((r) => JSON.parse(r.data) as Instance);

    return {
      candidate_id: stateRow.candidate_id,
      strategy,
      instances,
      state: stateRow.state,
      dormant_reason: stateRow.dormant_reason,
      created_at: stateRow.created_at,
      updated_at: stateRow.updated_at,
    };
  }

  /** 局部更新 Strategy（不改 ID / state）。 */
  updateStrategy(
    candidateId: string,
    patch: Partial<Omit<Strategy, 'strategy_id' | 'created_at'>>,
  ): Candidate {
    const current = this.get(candidateId);
    if (!current) throw new CandidateNotFoundError(candidateId);

    const merged: Strategy = {
      ...current.strategy,
      ...patch,
    };

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE strategies
        SET problem_category = ?, trigger_conditions = ?, recommended_action = ?,
            scope = ?, tags = ?, data = ?
        WHERE strategy_id = ?
      `).run(
        merged.problem_category,
        merged.trigger_conditions,
        merged.recommended_action,
        merged.scope,
        merged.tags ? JSON.stringify(merged.tags) : null,
        JSON.stringify(merged),
        current.strategy.strategy_id,
      );
      this.touch(candidateId);
    });
    tx();
    return this.get(candidateId)!;
  }

  delete(candidateId: string): boolean {
    const info = this.db.prepare(
      `DELETE FROM candidate_state WHERE candidate_id = ?`,
    ).run(candidateId);
    // FK ON DELETE CASCADE 会清理 instances + state_transitions + strategies（strategies 通过手动删除）
    // 但我们 strategies 不是 candidate_state 的 FK 从属，手动删：
    this.db.prepare(`DELETE FROM strategies WHERE strategy_id = ?`).run(candidateId);
    return info.changes > 0;
  }

  private touch(candidateId: string): void {
    this.db.prepare(
      `UPDATE candidate_state SET updated_at = ? WHERE candidate_id = ?`,
    ).run(new Date().toISOString(), candidateId);
  }

  // -------------------------------------------------------------------------
  // list / filter
  // -------------------------------------------------------------------------

  list(filter: ListFilter = {}): Candidate[] {
    const where: string[] = [];
    const params: unknown[] = [];

    const pushIn = (col: string, v: unknown) => {
      const arr = Array.isArray(v) ? v : [v];
      if (arr.length === 0) return;
      where.push(`${col} IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    };

    if (filter.state !== undefined) pushIn('cs.state', filter.state);
    if (filter.scope !== undefined) pushIn('s.scope', filter.scope);
    if (filter.problemCategory !== undefined)
      pushIn('s.problem_category', filter.problemCategory);
    if (filter.dormantReason !== undefined) {
      where.push('cs.dormant_reason = ?');
      params.push(filter.dormantReason);
    }

    const limit = filter.limit ?? 1000;
    const offset = filter.offset ?? 0;

    const sql = `
      SELECT cs.candidate_id
      FROM candidate_state cs
      JOIN strategies s ON s.strategy_id = cs.strategy_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY cs.created_at ASC
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as Array<{
      candidate_id: string;
    }>;

    const out: Candidate[] = [];
    for (const r of rows) {
      const c = this.get(r.candidate_id);
      if (c) out.push(c);
    }
    return out;
  }

  count(filter: ListFilter = {}): number {
    const where: string[] = [];
    const params: unknown[] = [];

    const pushIn = (col: string, v: unknown) => {
      const arr = Array.isArray(v) ? v : [v];
      if (arr.length === 0) return;
      where.push(`${col} IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    };
    if (filter.state !== undefined) pushIn('cs.state', filter.state);
    if (filter.scope !== undefined) pushIn('s.scope', filter.scope);
    if (filter.problemCategory !== undefined)
      pushIn('s.problem_category', filter.problemCategory);
    if (filter.dormantReason !== undefined) {
      where.push('cs.dormant_reason = ?');
      params.push(filter.dormantReason);
    }
    const sql = `
      SELECT COUNT(*) AS n
      FROM candidate_state cs
      JOIN strategies s ON s.strategy_id = cs.strategy_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `;
    const row = this.db.prepare(sql).get(...params) as { n: number };
    return row.n;
  }

  // -------------------------------------------------------------------------
  // 状态机：transition
  // -------------------------------------------------------------------------

  /**
   * 执行状态转移。
   * - fromState 为**期望**的当前状态，若不匹配则抛 IllegalTransitionError（乐观并发）。
   * - action 必须在 §5.2.2 规则表中存在。
   * - 进入 dormant 时必须在 opts.dormantReason 中提供 reason。
   * - 从 dormant 出发时，若规则指定了 sourceDormantReason，当前 dormant_reason 必须匹配。
   */
  transition(
    candidateId: string,
    fromState: CandidateState,
    toState: CandidateState,
    action: string,
    opts: TransitionOptions = {},
  ): Candidate {
    const actor: TransitionActor = opts.actor ?? this.defaultActor;

    const run = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT state, dormant_reason FROM candidate_state WHERE candidate_id = ?`,
      ).get(candidateId) as
        | { state: CandidateState; dormant_reason: DormantReason | null }
        | undefined;

      if (!row) throw new CandidateNotFoundError(candidateId);

      if (row.state !== fromState) {
        throw new IllegalTransitionError(
          candidateId,
          fromState,
          toState,
          action,
          `actual current state is '${row.state}', not '${fromState}'`,
        );
      }

      // 寻找匹配规则
      const rule = TRANSITION_RULES.find((r) => {
        if (r.action !== action) return false;
        if (r.to !== toState) return false;
        if (r.from === '*') {
          if (r.fromExcept?.includes(fromState)) return false;
        } else {
          if (r.from !== fromState) return false;
        }
        if (r.actor !== 'both' && r.actor !== actor) return false;
        if (r.sourceDormantReason) {
          if (row.dormant_reason !== r.sourceDormantReason) return false;
        }
        return true;
      });

      if (!rule) {
        throw new IllegalTransitionError(
          candidateId,
          fromState,
          toState,
          action,
          `no matching rule (actor=${actor}` +
            (row.dormant_reason ? `, source_dormant_reason=${row.dormant_reason}` : '') +
            `)`,
        );
      }

      // 进入 dormant 必须带 reason
      let newDormantReason: DormantReason | null = null;
      if (toState === 'dormant') {
        if (!opts.dormantReason) {
          throw new IllegalTransitionError(
            candidateId,
            fromState,
            toState,
            action,
            `transition into 'dormant' requires opts.dormantReason`,
          );
        }
        newDormantReason = opts.dormantReason;
      }

      const now = new Date().toISOString();

      this.db.prepare(`
        UPDATE candidate_state
        SET state = ?, dormant_reason = ?, updated_at = ?
        WHERE candidate_id = ?
      `).run(toState, newDormantReason, now, candidateId);

      this.db.prepare(`
        INSERT INTO state_transitions (
          candidate_id, from_state, to_state, action, actor, dormant_reason, transitioned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidateId,
        fromState,
        toState,
        action,
        actor,
        newDormantReason ?? row.dormant_reason ?? null,
        now,
      );
    });

    run();
    return this.get(candidateId)!;
  }

  /** 返回某候选的状态转移历史（审计用） */
  getTransitions(candidateId: string): Array<{
    from_state: string;
    to_state: string;
    action: string;
    actor: string;
    dormant_reason: string | null;
    transitioned_at: string;
  }> {
    return this.db.prepare(`
      SELECT from_state, to_state, action, actor, dormant_reason, transitioned_at
      FROM state_transitions
      WHERE candidate_id = ?
      ORDER BY id ASC
    `).all(candidateId) as Array<{
      from_state: string;
      to_state: string;
      action: string;
      actor: string;
      dormant_reason: string | null;
      transitioned_at: string;
    }>;
  }

  // -------------------------------------------------------------------------
  // YAML import / export（§5.1.6：仅作人类可读交换格式，不作主存储）
  // -------------------------------------------------------------------------

  /** 导出 Candidate 为 YAML 字符串（§5.1.5 格式）。 */
  exportYaml(candidateId: string): string {
    const c = this.get(candidateId);
    if (!c) throw new CandidateNotFoundError(candidateId);
    const doc = {
      strategy: c.strategy,
      instances: c.instances,
      state: c.state,
      dormant_reason: c.dormant_reason ?? undefined,
    };
    return YAML.stringify(doc);
  }

  /**
   * 从 YAML 字符串导入 Candidate（upsert 语义：若 candidate_id 已存在则抛错，
   * 调用方可以先 delete 再 import）。
   */
  importYaml(yamlText: string): Candidate {
    const parsed = YAML.parse(yamlText) as {
      strategy: Strategy;
      instances?: Instance[];
      state?: CandidateState;
      dormant_reason?: DormantReason | null;
    };

    if (!parsed?.strategy?.strategy_id) {
      throw new Error('YAML import: missing strategy.strategy_id');
    }

    const existing = this.get(parsed.strategy.strategy_id);
    if (existing) {
      throw new Error(
        `YAML import: candidate ${parsed.strategy.strategy_id} already exists; delete first`,
      );
    }

    return this.create({
      strategy: parsed.strategy,
      instances: parsed.instances ?? [],
      initialState: parsed.state ?? 'pending',
      dormantReason: parsed.dormant_reason ?? null,
    });
  }

  // -------------------------------------------------------------------------
  // Reflection watermark & dedup
  // -------------------------------------------------------------------------

  getWatermark(key = 'default'): string | null {
    const row = this.db.prepare('SELECT last_processed_date FROM reflection_watermark WHERE key = ?').get(key) as { last_processed_date: string } | undefined;
    return row?.last_processed_date ?? null;
  }

  setWatermark(date: string, key = 'default'): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO reflection_watermark (key, last_processed_date, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_processed_date = excluded.last_processed_date, updated_at = excluded.updated_at',
    ).run(key, date, now);
  }

  hasReflectionLog(date: string, sourceHash: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM reflection_log WHERE date = ? AND source_hash = ?').get(date, sourceHash);
    return !!row;
  }

  addReflectionLog(date: string, sourceHash: string, candidatesCount: number): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT OR IGNORE INTO reflection_log (date, source_hash, candidates_count, created_at) VALUES (?, ?, ?, ?)',
    ).run(date, sourceHash, candidatesCount, now);
  }
}

// ---------------------------------------------------------------------------
// 便捷工厂
// ---------------------------------------------------------------------------

export function openCandidateStore(opts: CandidateStoreOptions): CandidateStore {
  return new CandidateStore(opts);
}
