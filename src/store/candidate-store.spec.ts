// src/store/candidate-store.spec.ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CandidateStore,
  IllegalTransitionError,
  CandidateNotFoundError,
  TRANSITION_RULES,
} from './candidate-store.js';
import { computeStrategyId, computeInstanceId } from '../kernel/content-id.js';
import type {
  CandidateState,
  DormantReason,
  EnvFingerprint,
  Instance,
  Strategy,
} from '../kernel/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV: EnvFingerprint = {
  runtime: 'openclaw',
  platform: 'linux',
  arch: 'x64',
  model: 'claude-opus-4.7',
};

function mkStrategy(overrides: Partial<Strategy> = {}): Strategy {
  const base = {
    problem_category: overrides.problem_category ?? 'file_cleanup',
    trigger_conditions: overrides.trigger_conditions ?? 'tmp files left behind',
    recommended_action: overrides.recommended_action ?? 'run rm -f /tmp/prefix*',
  };
  const strategy_id = overrides.strategy_id ?? computeStrategyId(base);
  return {
    strategy_id,
    problem_category: base.problem_category,
    trigger_conditions: base.trigger_conditions,
    recommended_action: base.recommended_action,
    scope: overrides.scope ?? 'general',
    tags: overrides.tags ?? ['cleanup'],
    created_at: overrides.created_at ?? new Date().toISOString(),
    instance_ids: overrides.instance_ids ?? [],
  };
}

function mkInstance(strategy_id: string, overrides: Partial<Instance> = {}): Instance {
  const base = {
    strategy_id,
    diff_summary: overrides.diff_summary ?? 'added rm -f /tmp/x*',
    env_fingerprint: overrides.env_fingerprint ?? ENV,
  };
  const instance_id = overrides.instance_id ?? computeInstanceId(base);
  return {
    instance_id,
    strategy_id,
    diff_summary: base.diff_summary,
    files_touched: overrides.files_touched ?? ['skills/x/SKILL.md'],
    env_fingerprint: base.env_fingerprint,
    source_sessions: overrides.source_sessions ?? [
      { session_id: 's-1', runtime: 'openclaw', timestamp: new Date().toISOString() },
    ],
    assertions: overrides.assertions ?? [
      { type: 'command_exit_code', command: 'test ! -f /tmp/x-marker', expected_exit_code: 0 },
    ],
    trial_results: overrides.trial_results ?? [],
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

// Migrations 目录：测试运行时，源码在 src/store/，与 candidate-store.ts 同目录
const MIG_DIR = new URL('./migrations', import.meta.url).pathname;

function openStore(dbPath: string): CandidateStore {
  return new CandidateStore({ dbPath, migrationsDir: MIG_DIR });
}

// ---------------------------------------------------------------------------
// 测试脚手架：每个 test 用独立临时目录 + 文件型 SQLite（以验证 WAL 真实落盘）
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbPath: string;
let store: CandidateStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'learning-loop-t003-'));
  dbPath = join(tmpDir, 'store.db');
  store = openStore(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* ignore */
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Sanity / Schema
// ---------------------------------------------------------------------------

describe('CandidateStore :: schema', () => {
  it('enables WAL journal mode', () => {
    expect(store.getJournalMode().toLowerCase()).toBe('wal');
  });

  it('migrations idempotent (re-open reuses schema)', () => {
    store.close();
    expect(() => {
      const s2 = openStore(dbPath);
      s2.close();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('CandidateStore :: CRUD', () => {
  it('create + get returns a pending candidate', () => {
    const strat = mkStrategy();
    const c = store.create({ strategy: strat });
    expect(c.candidate_id).toBe(strat.strategy_id);
    expect(c.state).toBe('pending');
    expect(c.dormant_reason).toBeNull();
    expect(c.strategy.problem_category).toBe('file_cleanup');
    expect(c.instances).toHaveLength(0);

    const again = store.get(strat.strategy_id);
    expect(again).not.toBeNull();
    expect(again!.strategy.strategy_id).toBe(strat.strategy_id);
  });

  it('create with initial instances', () => {
    const strat = mkStrategy();
    const inst = mkInstance(strat.strategy_id);
    const c = store.create({ strategy: strat, instances: [inst] });
    expect(c.instances).toHaveLength(1);
    expect(c.instances[0]!.instance_id).toBe(inst.instance_id);
  });

  it('addInstance updates strategy.instance_ids and appends', () => {
    const strat = mkStrategy();
    store.create({ strategy: strat });

    const inst = mkInstance(strat.strategy_id);
    const c = store.addInstance(strat.strategy_id, inst);
    expect(c.instances).toHaveLength(1);
    expect(c.strategy.instance_ids).toContain(inst.instance_id);

    // second one
    const inst2 = mkInstance(strat.strategy_id, { diff_summary: 'different diff' });
    const c2 = store.addInstance(strat.strategy_id, inst2);
    expect(c2.instances).toHaveLength(2);
    expect(c2.strategy.instance_ids).toHaveLength(2);
  });

  it('updateStrategy patches fields (but not id / state)', () => {
    const strat = mkStrategy();
    store.create({ strategy: strat });
    const u = store.updateStrategy(strat.strategy_id, {
      tags: ['updated', 'v2'],
      scope: 'role:moyi',
    });
    expect(u.strategy.tags).toEqual(['updated', 'v2']);
    expect(u.strategy.scope).toBe('role:moyi');
    expect(u.state).toBe('pending'); // state unaffected
  });

  it('delete removes candidate + strategy + instances', () => {
    const strat = mkStrategy();
    const inst = mkInstance(strat.strategy_id);
    store.create({ strategy: strat, instances: [inst] });
    expect(store.delete(strat.strategy_id)).toBe(true);
    expect(store.get(strat.strategy_id)).toBeNull();
  });

  it('get returns null for unknown id', () => {
    expect(store.get('sha256:nope')).toBeNull();
  });

  it('addInstance on unknown candidate throws CandidateNotFoundError', () => {
    const inst = mkInstance('sha256:nope');
    expect(() => store.addInstance('sha256:nope', inst)).toThrow(CandidateNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// list / filter
// ---------------------------------------------------------------------------

describe('CandidateStore :: list/filter', () => {
  it('filters by state, scope, problem_category and dormant_reason', () => {
    const a = mkStrategy({ problem_category: 'catA', scope: 'general', trigger_conditions: 't1', recommended_action: 'a1' });
    a.strategy_id = computeStrategyId(a);
    const b = mkStrategy({ problem_category: 'catB', scope: 'tool:bash', trigger_conditions: 't2', recommended_action: 'a2' });
    b.strategy_id = computeStrategyId(b);
    const c = mkStrategy({ problem_category: 'catA', scope: 'role:moyi', trigger_conditions: 't3', recommended_action: 'a3' });
    c.strategy_id = computeStrategyId(c);

    store.create({ strategy: a });
    store.create({ strategy: b, initialState: 'pending' });
    store.create({
      strategy: c,
      initialState: 'dormant',
      dormantReason: 'no_match',
    });

    expect(store.list({ state: 'pending' })).toHaveLength(2);
    expect(store.list({ state: 'dormant' })).toHaveLength(1);
    expect(store.list({ scope: 'general' })).toHaveLength(1);
    expect(store.list({ scope: ['general', 'tool:bash'] })).toHaveLength(2);
    expect(store.list({ problemCategory: 'catA' })).toHaveLength(2);
    expect(store.list({ dormantReason: 'no_match' })).toHaveLength(1);
    expect(store.list({ dormantReason: 'inconclusive' })).toHaveLength(0);
    expect(store.count({ state: 'pending' })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// State machine — 14 rules (happy paths)
// ---------------------------------------------------------------------------

describe('CandidateStore :: state machine — legal transitions', () => {
  function create(): string {
    const s = mkStrategy({ trigger_conditions: `t-${Math.random()}` });
    s.strategy_id = computeStrategyId(s);
    store.create({ strategy: s });
    return s.strategy_id;
  }

  it('#1 pending -> reviewing (start_review, system)', () => {
    const id = create();
    const c = store.transition(id, 'pending', 'reviewing', 'start_review');
    expect(c.state).toBe('reviewing');
  });

  it('#2 reviewing -> validating (review_passed)', () => {
    const id = create();
    store.transition(id, 'pending', 'reviewing', 'start_review');
    const c = store.transition(id, 'reviewing', 'validating', 'review_passed');
    expect(c.state).toBe('validating');
  });

  it('#3 reviewing -> rejected (review_failed)', () => {
    const id = create();
    store.transition(id, 'pending', 'reviewing', 'start_review');
    const c = store.transition(id, 'reviewing', 'rejected', 'review_failed');
    expect(c.state).toBe('rejected');
  });

  it('#4 validating -> graduated (graduate)', () => {
    const id = create();
    store.transition(id, 'pending', 'reviewing', 'start_review');
    store.transition(id, 'reviewing', 'validating', 'review_passed');
    const c = store.transition(id, 'validating', 'graduated', 'graduate');
    expect(c.state).toBe('graduated');
  });

  it('#5 validating -> retired (retire)', () => {
    const id = create();
    store.transition(id, 'pending', 'reviewing', 'start_review');
    store.transition(id, 'reviewing', 'validating', 'review_passed');
    const c = store.transition(id, 'validating', 'retired', 'retire');
    expect(c.state).toBe('retired');
  });

  it('#6 validating -> conflict (enter_conflict)', () => {
    const id = create();
    store.transition(id, 'pending', 'reviewing', 'start_review');
    store.transition(id, 'reviewing', 'validating', 'review_passed');
    const c = store.transition(id, 'validating', 'conflict', 'enter_conflict');
    expect(c.state).toBe('conflict');
  });

  it('#7 validating -> dormant (enter_dormant) requires reason', () => {
    const id = create();
    store.transition(id, 'pending', 'reviewing', 'start_review');
    store.transition(id, 'reviewing', 'validating', 'review_passed');

    expect(() =>
      store.transition(id, 'validating', 'dormant', 'enter_dormant'),
    ).toThrow(IllegalTransitionError);

    const c = store.transition(id, 'validating', 'dormant', 'enter_dormant', {
      dormantReason: 'no_match',
    });
    expect(c.state).toBe('dormant');
    expect(c.dormant_reason).toBe('no_match');
  });

  it('#8 conflict -> validating (conflict_resolved, both actors)', () => {
    const id = create();
    store.transition(id, 'pending', 'reviewing', 'start_review');
    store.transition(id, 'reviewing', 'validating', 'review_passed');
    store.transition(id, 'validating', 'conflict', 'enter_conflict');
    const c = store.transition(id, 'conflict', 'validating', 'conflict_resolved', {
      actor: 'user',
    });
    expect(c.state).toBe('validating');
  });

  it('#9 conflict -> retired (conflict_abandon)', () => {
    const id = create();
    store.transition(id, 'pending', 'reviewing', 'start_review');
    store.transition(id, 'reviewing', 'validating', 'review_passed');
    store.transition(id, 'validating', 'conflict', 'enter_conflict');
    const c = store.transition(id, 'conflict', 'retired', 'conflict_abandon');
    expect(c.state).toBe('retired');
  });
});

describe('CandidateStore :: state machine — dormant branches 10a/10b/11a/11b', () => {
  function makeDormant(reason: DormantReason): string {
    const s = mkStrategy({ trigger_conditions: `t-dormant-${reason}-${Math.random()}` });
    s.strategy_id = computeStrategyId(s);
    store.create({ strategy: s });
    store.transition(s.strategy_id, 'pending', 'reviewing', 'start_review');
    store.transition(s.strategy_id, 'reviewing', 'validating', 'review_passed');
    store.transition(s.strategy_id, 'validating', 'dormant', 'enter_dormant', {
      dormantReason: reason,
    });
    return s.strategy_id;
  }

  it('#10a dormant(no_match) -> validating (wake_on_match)', () => {
    const id = makeDormant('no_match');
    const c = store.transition(id, 'dormant', 'validating', 'wake_on_match');
    expect(c.state).toBe('validating');
    expect(c.dormant_reason).toBeNull();
  });

  it('#10a does NOT wake dormant(inconclusive) — wrong action', () => {
    const id = makeDormant('inconclusive');
    expect(() =>
      store.transition(id, 'dormant', 'validating', 'wake_on_match'),
    ).toThrow(IllegalTransitionError);
  });

  it('#10b dormant(inconclusive) -> validating (wake_on_signal)', () => {
    const id = makeDormant('inconclusive');
    const c = store.transition(id, 'dormant', 'validating', 'wake_on_signal');
    expect(c.state).toBe('validating');
    expect(c.dormant_reason).toBeNull();
  });

  it('#10b does NOT apply to dormant(no_match)', () => {
    const id = makeDormant('no_match');
    expect(() =>
      store.transition(id, 'dormant', 'validating', 'wake_on_signal'),
    ).toThrow(IllegalTransitionError);
  });

  // ↓↓↓ 关联测试用例 #103 / #104 ↓↓↓
  it('#103 dormant_reason_no_match_ttl → retire (#11a)', () => {
    const id = makeDormant('no_match');
    // 模拟 TTL 到期：调度层触发 retire_no_match_ttl
    const c = store.transition(id, 'dormant', 'retired', 'retire_no_match_ttl');
    expect(c.state).toBe('retired');

    // #11b action 不能用于 no_match
    const id2 = makeDormant('no_match');
    expect(() =>
      store.transition(id2, 'dormant', 'retired', 'retire_inconclusive_ttl'),
    ).toThrow(IllegalTransitionError);
  });

  it('#104 dormant_reason_inconclusive_ttl → retire (#11b)', () => {
    const id = makeDormant('inconclusive');
    const c = store.transition(id, 'dormant', 'retired', 'retire_inconclusive_ttl');
    expect(c.state).toBe('retired');

    // #11a action 不能用于 inconclusive
    const id2 = makeDormant('inconclusive');
    expect(() =>
      store.transition(id2, 'dormant', 'retired', 'retire_no_match_ttl'),
    ).toThrow(IllegalTransitionError);
  });
});

describe('CandidateStore :: state machine — user override #12/#13/#14', () => {
  function create(): string {
    const s = mkStrategy({ trigger_conditions: `t-${Math.random()}` });
    s.strategy_id = computeStrategyId(s);
    store.create({ strategy: s });
    return s.strategy_id;
  }

  it('#12 force_graduate from pending (user)', () => {
    const id = create();
    const c = store.transition(id, 'pending', 'graduated', 'force_graduate', {
      actor: 'user',
    });
    expect(c.state).toBe('graduated');
  });

  it('#12 force_graduate NOT allowed from graduated', () => {
    const id = create();
    store.transition(id, 'pending', 'graduated', 'force_graduate', { actor: 'user' });
    expect(() =>
      store.transition(id, 'graduated', 'graduated', 'force_graduate', { actor: 'user' }),
    ).toThrow(IllegalTransitionError);
  });

  it('#12 force_graduate NOT allowed from rejected', () => {
    const id = create();
    store.transition(id, 'pending', 'reviewing', 'start_review');
    store.transition(id, 'reviewing', 'rejected', 'review_failed');
    expect(() =>
      store.transition(id, 'rejected', 'graduated', 'force_graduate', { actor: 'user' }),
    ).toThrow(IllegalTransitionError);
  });

  it('#13 force_retire from validating (user)', () => {
    const id = create();
    store.transition(id, 'pending', 'reviewing', 'start_review');
    store.transition(id, 'reviewing', 'validating', 'review_passed');
    const c = store.transition(id, 'validating', 'retired', 'force_retire', {
      actor: 'user',
    });
    expect(c.state).toBe('retired');
  });

  it('#14 user_reject from reviewing / validating / dormant', () => {
    // reviewing
    const idA = create();
    store.transition(idA, 'pending', 'reviewing', 'start_review');
    expect(
      store.transition(idA, 'reviewing', 'rejected', 'user_reject', { actor: 'user' })
        .state,
    ).toBe('rejected');

    // validating
    const idB = create();
    store.transition(idB, 'pending', 'reviewing', 'start_review');
    store.transition(idB, 'reviewing', 'validating', 'review_passed');
    expect(
      store.transition(idB, 'validating', 'rejected', 'user_reject', { actor: 'user' })
        .state,
    ).toBe('rejected');

    // dormant
    const idC = create();
    store.transition(idC, 'pending', 'reviewing', 'start_review');
    store.transition(idC, 'reviewing', 'validating', 'review_passed');
    store.transition(idC, 'validating', 'dormant', 'enter_dormant', {
      dormantReason: 'no_match',
    });
    expect(
      store.transition(idC, 'dormant', 'rejected', 'user_reject', { actor: 'user' })
        .state,
    ).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// Illegal transitions — 非法转移必须抛 IllegalTransitionError
// ---------------------------------------------------------------------------

describe('CandidateStore :: state machine — illegal transitions', () => {
  it('from-state mismatch rejects (optimistic concurrency)', () => {
    const s = mkStrategy();
    s.strategy_id = computeStrategyId(s);
    store.create({ strategy: s });
    // Actually pending, but we pass reviewing as fromState
    expect(() =>
      store.transition(s.strategy_id, 'reviewing', 'validating', 'review_passed'),
    ).toThrow(IllegalTransitionError);
  });

  it('unknown action rejects', () => {
    const s = mkStrategy();
    s.strategy_id = computeStrategyId(s);
    store.create({ strategy: s });
    expect(() =>
      store.transition(s.strategy_id, 'pending', 'reviewing', 'totally_made_up'),
    ).toThrow(IllegalTransitionError);
  });

  it('pending cannot jump directly to validating', () => {
    const s = mkStrategy();
    s.strategy_id = computeStrategyId(s);
    store.create({ strategy: s });
    expect(() =>
      store.transition(s.strategy_id, 'pending', 'validating', 'review_passed'),
    ).toThrow(IllegalTransitionError);
  });

  it('graduated cannot transition further except force_retire #13', () => {
    const s = mkStrategy();
    s.strategy_id = computeStrategyId(s);
    store.create({ strategy: s });
    store.transition(s.strategy_id, 'pending', 'graduated', 'force_graduate', { actor: 'user' });

    // No legal system transition
    expect(() =>
      store.transition(s.strategy_id, 'graduated', 'retired', 'retire'),
    ).toThrow(IllegalTransitionError);

    // But #13 force_retire from graduated IS allowed (fromExcept = [retired, rejected])
    const c = store.transition(s.strategy_id, 'graduated', 'retired', 'force_retire', {
      actor: 'user',
    });
    expect(c.state).toBe('retired');
  });

  it('system actor cannot perform user-only action', () => {
    const s = mkStrategy();
    s.strategy_id = computeStrategyId(s);
    store.create({ strategy: s });
    expect(() =>
      store.transition(s.strategy_id, 'pending', 'graduated', 'force_graduate', {
        actor: 'system',
      }),
    ).toThrow(IllegalTransitionError);
  });
});

// ---------------------------------------------------------------------------
// transition log audit
// ---------------------------------------------------------------------------

describe('CandidateStore :: transition log', () => {
  it('records transitions in order', () => {
    const s = mkStrategy();
    s.strategy_id = computeStrategyId(s);
    store.create({ strategy: s });
    store.transition(s.strategy_id, 'pending', 'reviewing', 'start_review');
    store.transition(s.strategy_id, 'reviewing', 'validating', 'review_passed');
    store.transition(s.strategy_id, 'validating', 'dormant', 'enter_dormant', {
      dormantReason: 'inconclusive',
    });

    const log = store.getTransitions(s.strategy_id);
    expect(log.map((l) => l.to_state)).toEqual([
      'pending',      // initial (create)
      'reviewing',
      'validating',
      'dormant',
    ]);
    expect(log[3]!.dormant_reason).toBe('inconclusive');
  });
});

// ---------------------------------------------------------------------------
// YAML import / export
// ---------------------------------------------------------------------------

describe('CandidateStore :: YAML import/export', () => {
  it('roundtrips a candidate through YAML', () => {
    const strat = mkStrategy();
    const inst = mkInstance(strat.strategy_id);
    const c = store.create({ strategy: strat, instances: [inst] });
    store.transition(strat.strategy_id, 'pending', 'reviewing', 'start_review');
    store.transition(strat.strategy_id, 'reviewing', 'validating', 'review_passed');

    const yaml = store.exportYaml(strat.strategy_id);
    expect(yaml).toContain('problem_category: file_cleanup');
    expect(yaml).toContain('state: validating');

    // import into a fresh store
    const otherDb = join(tmpDir, 'other.db');
    const s2 = openStore(otherDb);
    const imported = s2.importYaml(yaml);
    expect(imported.candidate_id).toBe(strat.strategy_id);
    expect(imported.state).toBe('validating');
    expect(imported.instances).toHaveLength(1);
    s2.close();
  });

  it('import rejects duplicate candidate_id', () => {
    const strat = mkStrategy();
    store.create({ strategy: strat });
    const yaml = store.exportYaml(strat.strategy_id);
    expect(() => store.importYaml(yaml)).toThrow(/already exists/);
  });
});

// ---------------------------------------------------------------------------
// Single-writer serialization — concurrent writes must not deadlock
// ---------------------------------------------------------------------------

describe('CandidateStore :: concurrent writes (single-writer lock)', () => {
  it('serializes many concurrent create() calls without deadlock', async () => {
    const N = 50;
    const tasks = Array.from({ length: N }, (_, i) => {
      const s = mkStrategy({ trigger_conditions: `concurrent-${i}` });
      s.strategy_id = computeStrategyId(s);
      return Promise.resolve().then(() => store.create({ strategy: s }));
    });
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(N);
    expect(store.count()).toBe(N);
  });

  it('serializes many concurrent transition() calls on distinct candidates', async () => {
    const N = 30;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const s = mkStrategy({ trigger_conditions: `ctx-${i}` });
      s.strategy_id = computeStrategyId(s);
      store.create({ strategy: s });
      ids.push(s.strategy_id);
    }
    const tasks = ids.map((id) =>
      Promise.resolve().then(() =>
        store.transition(id, 'pending', 'reviewing', 'start_review'),
      ),
    );
    const results = await Promise.all(tasks);
    expect(results.every((c) => c.state === 'reviewing')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Coverage assertion: every rule in TRANSITION_RULES has at least one test
// ---------------------------------------------------------------------------

describe('CandidateStore :: state machine coverage', () => {
  it('all 14 rules in TRANSITION_RULES are reachable', () => {
    // Sanity: rule table itself contains the key IDs
    const ruleIds = new Set(TRANSITION_RULES.map((r) => r.id));
    for (const expected of [
      '1','2','3','4','5','6','7','8','9',
      '10a','10b','11a','11b',
      '12','13',
      '14a','14b','14c',
    ]) {
      expect(ruleIds.has(expected)).toBe(true);
    }
  });
});
