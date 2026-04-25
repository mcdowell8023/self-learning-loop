// src/cli/review.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runReview } from './review.js';
import { openCandidateStore, type CandidateStore } from '../store/candidate-store.js';
import { createHash } from 'node:crypto';
import type { Strategy, Instance } from '../kernel/types.js';

function capture() {
  let out = '';
  let err = '';
  return {
    stdout: (s: string) => { out += s; },
    stderr: (s: string) => { err += s; },
    out: () => out,
    err: () => err,
  };
}

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function mkStrategy(id?: string): Strategy {
  const sid = id ?? sha(`s-${Math.random()}-${Date.now()}`);
  return {
    strategy_id: sid,
    problem_category: 'test-cat',
    trigger_conditions: 'when test condition',
    recommended_action: 'do the test action',
    scope: 'general',
    tags: [],
    created_at: new Date().toISOString(),
    instance_ids: [sid + '-i'],
  };
}

function mkInstance(strategyId: string): Instance {
  return {
    instance_id: strategyId + '-i',
    strategy_id: strategyId,
    diff_summary: 'diff',
    files_touched: ['a.ts'],
    env_fingerprint: { runtime: 'openclaw', platform: 'linux', arch: 'x64' },
    source_sessions: [
      { session_id: 's1', runtime: 'openclaw', timestamp: new Date().toISOString() },
    ],
    assertions: [],
    trial_results: [],
    created_at: new Date().toISOString(),
  };
}

describe('review CLI', () => {
  let store: CandidateStore;

  beforeEach(() => {
    store = openCandidateStore({ dbPath: ':memory:', defaultActor: 'system' });
  });

  afterEach(() => {
    try { store.close(); } catch {}
  });

  it('shows help with no args', async () => {
    const c = capture();
    const r = await runReview({ argv: [], stdout: c.stdout, stderr: c.stderr, store });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('list');
    expect(c.out()).toContain('show');
  });

  it('review list with empty store', async () => {
    const c = capture();
    const r = await runReview({ argv: ['list'], stdout: c.stdout, stderr: c.stderr, store });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('No candidates found');
  });

  it('review list shows candidates', async () => {
    const strategy = mkStrategy('strat-list-001');
    const instance = mkInstance(strategy.strategy_id);
    store.create({ strategy, instances: [instance] });

    const c = capture();
    const r = await runReview({ argv: ['list'], stdout: c.stdout, stderr: c.stderr, store });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('strat-list-001');
    expect(c.out()).toContain('pending');
  });

  it('review show for missing candidate', async () => {
    const c = capture();
    const r = await runReview({ argv: ['show', 'nonexistent'], stdout: c.stdout, stderr: c.stderr, store });
    expect(r.exitCode).toBe(3);
    expect(c.err()).toContain('not found');
  });

  it('review show displays candidate details', async () => {
    const strategy = mkStrategy('strat-show-002');
    const instance = mkInstance(strategy.strategy_id);
    store.create({ strategy, instances: [instance] });

    const c = capture();
    const r = await runReview({ argv: ['show', 'strat-show-002'], stdout: c.stdout, stderr: c.stderr, store });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('strat-show-002');
    expect(c.out()).toContain('pending');
    expect(c.out()).toContain('general');
  });
});
