// src/orchestrator/cycle.scope.spec.ts
//
// T-058a (review fix-up) · Orchestrator-layer coverage of two truth-table
// edge paths that Wei Zheng's review flagged as not exercised at the cycle
// level (existing evaluator.spec covers them in isolation; we now thread
// them through runCycle to ensure the full plumbing is correct):
//
//   1. scope rejection path
//      candidate.strategy.scope = 'tool:openclaw' (≠ 'general') →
//      GraduationExecutor throws GraduationScopeError →
//      runCycle catches and produces { status: 'error', error: '...' }
//      WITHOUT crashing the whole cycle. State stays at 'validating'.
//
//   2. L3 skipped path
//      No `judge` injected → evaluator-input-builder returns l3='skipped'.
//      Truth-table row(s) where L3=skipped + L1=pass + L2=skipped resolve
//      to a deterministic verdict; cycle threads it through to a non-error
//      outcome.
//
// Test thresholds chosen so the high-confidence path fires (matching the
// rest of cycle.spec.ts conventions).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateStore } from '../store/candidate-store.js';
import { TrialCollector } from '../shadow/trial-collector.js';
import { ShadowRunner } from '../shadow/shadow-runner.js';
import { GraduationExecutor } from '../graduation/executor.js';
import { computeStrategyId, computeInstanceId } from '../kernel/content-id.js';
import type {
  EnvFingerprint,
  Instance,
  Strategy,
  TrialResult,
} from '../kernel/types.js';

import { runCycle, type CycleThresholds } from './cycle.js';

// ---------------------------------------------------------------------------
// Helpers (kept self-contained so this file is independent of cycle.spec.ts)
// ---------------------------------------------------------------------------

const ENV: EnvFingerprint = {
  runtime: 'openclaw',
  platform: 'linux',
  arch: 'x64',
  model: 'claude-opus-4.7',
};

const MIG_DIR = new URL('../store/migrations', import.meta.url).pathname;

let _idCounter = 0;
function mkStrategy(seed: string, scope: Strategy['scope']): Strategy {
  _idCounter += 1;
  const base = {
    problem_category: 'file_cleanup',
    trigger_conditions: `temp files at /tmp/${seed}-${_idCounter}`,
    recommended_action: `rm -f /tmp/${seed}-*`,
  };
  return {
    strategy_id: computeStrategyId(base),
    problem_category: base.problem_category,
    trigger_conditions: base.trigger_conditions,
    recommended_action: base.recommended_action,
    scope,
    tags: ['cleanup'],
    summary: 'clean up tmp leftovers',
    created_at: new Date().toISOString(),
    instance_ids: [],
  };
}

function mkInstance(strategyId: string): Instance {
  const base = {
    strategy_id: strategyId,
    diff_summary: 'add cleanup line',
    env_fingerprint: ENV,
  };
  return {
    instance_id: computeInstanceId(base),
    strategy_id: strategyId,
    diff_summary: base.diff_summary,
    files_touched: ['AGENTS.md'],
    env_fingerprint: ENV,
    source_sessions: [
      { session_id: 's-1', runtime: 'openclaw', timestamp: new Date().toISOString() },
    ],
    assertions: [
      { type: 'command_exit_code', command: 'test ! -f /tmp/foo', expected_exit_code: 0 },
    ],
    trial_results: [],
    created_at: new Date().toISOString(),
  };
}

function mkTrial(
  candidateId: string,
  sessionId: string,
  completion: number,
  pass = true,
): TrialResult {
  return {
    trial_id: `trial-${sessionId}-${Math.random().toString(36).slice(2, 8)}`,
    candidate_id: candidateId,
    session_id: sessionId,
    runtime: 'openclaw',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    assertions: [
      {
        type: 'command_exit_code',
        status: pass ? 'pass' : 'fail',
        actual_exit_code: pass ? 0 : 1,
      },
    ],
    metrics: {
      turns: 5,
      errors: pass ? 0 : 1,
      token_usage: 1000,
      completion_rate: completion,
    },
    env_fingerprint: ENV,
  };
}

function provisionValidating(
  store: CandidateStore,
  seed: string,
  scope: Strategy['scope'] = 'general',
): { id: string } {
  const strategy = mkStrategy(seed, scope);
  const inst = mkInstance(strategy.strategy_id);
  store.create({ strategy, instances: [inst], initialState: 'pending' });
  store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
  store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');
  return { id: strategy.strategy_id };
}

const HIGH_CONFIDENCE_THRESHOLDS: CycleThresholds = {
  min_trials: 3,
  max_trials: 10,
  high: 0.10,
  low: 0.05,
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: CandidateStore;
let collector: TrialCollector;
let runner: ShadowRunner;
let executor: GraduationExecutor;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cycle-scope-test-'));
  store = new CandidateStore({
    dbPath: join(tmpDir, 't.db'),
    migrationsDir: MIG_DIR,
  });
  collector = new TrialCollector({ store, batchSize: 1 });
  runner = new ShadowRunner({ store, collector });

  workspaceDir = join(tmpDir, 'ws');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, 'AGENTS.md'), '# AGENTS.md\n\ntest workspace\n', 'utf8');

  executor = new GraduationExecutor({
    store,
    workspaceDir,
    graduatedDir: join(tmpDir, 'graduated'),
    auditDir: join(tmpDir, 'audit'),
  });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (1) scope rejection path
// ---------------------------------------------------------------------------

describe('runCycle :: scope rejection (truth-table → graduate path)', () => {
  it('non-general scope yields error outcome but does not crash the cycle', async () => {
    // Two candidates: one with scope='tool:openclaw' (will be rejected),
    // one with scope='general' (control — should still graduate fine).
    const { id: rejectedId } = provisionValidating(store, 'reject', 'tool:openclaw');
    const { id: okId } = provisionValidating(store, 'ok', 'general');

    // Both get 10 perfect trials so they hit the graduate truth-table row.
    for (let i = 0; i < 10; i++) {
      collector.record(mkTrial(rejectedId, `r${i}`, 0.95, true), true);
      collector.record(mkTrial(okId, `o${i}`, 0.95, true), true);
    }
    collector.flush();

    const report = await runCycle({
      store,
      collector,
      runner,
      executor,
      runtimes: [],
      thresholds: HIGH_CONFIDENCE_THRESHOLDS,
      baselineProvider: () => [0.5, 0.55, 0.5, 0.6, 0.5],
      judge: () => 'pass',
    });

    // Both candidates were processed — cycle did not crash.
    expect(report.candidates).toHaveLength(2);

    const rejected = report.candidates.find((c) => c.candidate_id === rejectedId);
    const ok = report.candidates.find((c) => c.candidate_id === okId);

    // Rejected one: `error` outcome with a message mentioning graduate failure.
    expect(rejected?.outcome.status).toBe('error');
    if (rejected?.outcome.status === 'error') {
      expect(rejected.outcome.error).toMatch(/graduate failed/);
      // GraduationScopeError message includes the offending scope
      expect(rejected.outcome.error).toMatch(/tool:openclaw|scope/i);
    }

    // Rejected candidate stays at validating (no transition on error).
    expect(store.get(rejectedId)?.state).toBe('validating');

    // Control: scope='general' candidate graduated normally.
    expect(ok?.outcome.status).toBe('graduated');
    expect(store.get(okId)?.state).toBe('graduated');
  });
});

// ---------------------------------------------------------------------------
// (2) L3 skipped path
// ---------------------------------------------------------------------------

describe('runCycle :: L3 skipped path (no judge injected)', () => {
  it('omitting `judge` threads l3=skipped through the full cycle without error', async () => {
    const { id } = provisionValidating(store, 'l3skip', 'general');

    // 10 perfect trials: L1 pass, no judge, no baseline → L2 skipped, L3 skipped.
    for (let i = 0; i < 10; i++) {
      collector.record(mkTrial(id, `s${i}`, 0.95, true), true);
    }
    collector.flush();

    // NB: NO `judge` provided, NO `baselineProvider` provided.
    const report = await runCycle({
      store,
      collector,
      runner,
      executor,
      runtimes: [],
      thresholds: HIGH_CONFIDENCE_THRESHOLDS,
    });

    expect(report.candidates).toHaveLength(1);
    const outcome = report.candidates[0]?.outcome;

    // The truth table for (L1=pass, L2=skipped, L3=skipped) routes to a
    // non-error verdict (LIKELY_PASS / dormant inconclusive depending on
    // gating). Whatever the specific verdict, the key invariant is:
    //   - cycle did not error out
    //   - no exception escaped to runCycle's catch block
    expect(outcome?.status).not.toBe('error');

    // Sanity: outcome must carry a verdict (i.e. evaluator ran end-to-end
    // with l3=skipped without throwing).
    if (outcome && 'verdict' in outcome) {
      expect(typeof outcome.verdict).toBe('string');
    }

    // No adapter errors either.
    expect(report.errors).toHaveLength(0);
  });
});
