// src/orchestrator/cycle.spec.ts
//
// T-058a · Cycle orchestrator + verdict routing tests.
//
// We exercise runCycle() with `runtimes: []` so adapter discovery is skipped
// and the test focuses on the Decision-Layer routing path:
//   - observed_only when trial_count < min_trials
//   - confidence three-tier gating (mid / low / high)
//   - graduated path actually invokes GraduationExecutor
//   - retired / dormant / conflict state transitions
//   - dryRun mode
//
// Adapter integration is covered by cycle.e2e.spec.ts (commit 4).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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
// Helpers
// ---------------------------------------------------------------------------

const ENV: EnvFingerprint = {
  runtime: 'openclaw',
  platform: 'linux',
  arch: 'x64',
  model: 'claude-opus-4.7',
};

const MIG_DIR = new URL('../store/migrations', import.meta.url).pathname;

let _idCounter = 0;
function mkStrategy(seed = 'default'): Strategy {
  // Vary content per call to make strategy_ids unique within a single test.
  _idCounter += 1;
  const base = {
    problem_category: 'file_cleanup',
    trigger_conditions: `temp files left at /tmp/${seed}-${_idCounter}`,
    recommended_action: `rm -f /tmp/${seed}-*`,
  };
  return {
    strategy_id: computeStrategyId(base),
    problem_category: base.problem_category,
    trigger_conditions: base.trigger_conditions,
    recommended_action: base.recommended_action,
    scope: 'general',
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
    source_sessions: [{ session_id: 's-1', runtime: 'openclaw', timestamp: new Date().toISOString() }],
    assertions: [
      { type: 'command_exit_code', command: 'test ! -f /tmp/foo', expected_exit_code: 0 },
    ],
    trial_results: [],
    created_at: new Date().toISOString(),
  };
}

function mkTrial(candidateId: string, sessionId: string, completion: number, pass = true): TrialResult {
  return {
    trial_id: `trial-${sessionId}-${Math.random().toString(36).slice(2, 8)}`,
    candidate_id: candidateId,
    session_id: sessionId,
    runtime: 'openclaw',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    assertions: [
      { type: 'command_exit_code', status: pass ? 'pass' : 'fail', actual_exit_code: pass ? 0 : 1 },
    ],
    metrics: { turns: 5, errors: pass ? 0 : 1, token_usage: 1000, completion_rate: completion },
    env_fingerprint: ENV,
  };
}

function provisionValidating(store: CandidateStore, seed = 'default'): { id: string } {
  const strategy = mkStrategy(seed);
  const inst = mkInstance(strategy.strategy_id);
  store.create({ strategy, instances: [inst], initialState: 'pending' });
  store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
  store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');
  return { id: strategy.strategy_id };
}

const DEFAULT_THRESHOLDS: CycleThresholds = {
  min_trials: 3,
  max_trials: 10,
  // Test-friendly thresholds: with L2 skipped (no baseline) confidence is
  // bounded by sampleWeight*(0.7) ≈ max ~0.7. We use 0.10/0.05 so the
  // "happy path" 10-trial 100% pass case lands in the high bucket.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'cycle-test-'));
  store = new CandidateStore({
    dbPath: join(tmpDir, 't.db'),
    migrationsDir: MIG_DIR,
  });
  collector = new TrialCollector({ store, batchSize: 1 });
  runner = new ShadowRunner({ store, collector });

  workspaceDir = join(tmpDir, 'ws');
  mkdirSync(workspaceDir, { recursive: true });
  // Pre-create AGENTS.md so executor's marker injection has a target.
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
// Tests
// ---------------------------------------------------------------------------

describe('runCycle :: trial gating', () => {
  it('observed_only when trial_count < min_trials', async () => {
    const { id } = provisionValidating(store, 'gating');
    // 2 trials, but min_trials = 3
    collector.record(mkTrial(id, 's1', 0.9), true);
    collector.record(mkTrial(id, 's2', 0.9), true);
    collector.flush();

    const report = await runCycle({
      store, collector, runner, executor,
      runtimes: [],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.outcome.status).toBe('observed_only');
    if (report.candidates[0]?.outcome.status === 'observed_only') {
      expect(report.candidates[0].outcome.trial_count).toBe(2);
    }
    // State unchanged
    expect(store.get(id)?.state).toBe('validating');
  });
});

describe('runCycle :: verdict routing (high confidence)', () => {
  it('PASS verdict → graduated (writes marker block + transitions state)', async () => {
    const { id } = provisionValidating(store, 'pass');
    // 10 perfect trials → high L1 pass-rate. Inject judge=pass so truth table
    // row #1 (L1pass / L2skipped→via baseline / L3pass) graduates.
    for (let i = 0; i < 10; i++) {
      collector.record(mkTrial(id, `s${i}`, 0.95, true), true);
    }
    collector.flush();

    const report = await runCycle({
      store, collector, runner, executor,
      runtimes: [],
      thresholds: DEFAULT_THRESHOLDS,
      // Provide synthetic baseline so L2 has something to compare to (mean diff > 0)
      baselineProvider: () => [0.5, 0.55, 0.5, 0.6, 0.5],
      judge: () => 'pass',
    });

    const outcome = report.candidates[0]?.outcome;
    expect(outcome?.status).toBe('graduated');
    expect(store.get(id)?.state).toBe('graduated');

    // Marker block actually written into AGENTS.md
    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(agentsContent).toMatch(/<!--\s*graduated:sha256:/);
    expect(agentsContent).toContain('file_cleanup');

    // Audit YAML written
    if (outcome?.status === 'graduated' && outcome.content_hash) {
      const auditPath = join(tmpDir, 'audit', 'graduations', `${outcome.content_hash}.yaml`);
      expect(existsSync(auditPath)).toBe(true);
    }
  });

  it('FAIL verdict → retired (no graduation file written)', async () => {
    const { id } = provisionValidating(store, 'fail');
    // 5 failing trials → L1 fail
    for (let i = 0; i < 5; i++) {
      collector.record(mkTrial(id, `s${i}`, 0.1, false), true);
    }
    collector.flush();

    const report = await runCycle({
      store, collector, runner, executor,
      runtimes: [],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(report.candidates[0]?.outcome.status).toBe('retired');
    expect(store.get(id)?.state).toBe('retired');

    // AGENTS.md untouched (no marker)
    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(agentsContent).not.toMatch(/<!--\s*graduated:sha256:/);
  });
});

describe('runCycle :: confidence three-tier gating', () => {
  it('mid confidence + non-fatal + < max_trials → awaiting_more_trials (no transition)', async () => {
    const { id } = provisionValidating(store, 'mid');
    for (let i = 0; i < 3; i++) {
      collector.record(mkTrial(id, `s${i}`, 0.7, true), true);
    }
    collector.flush();

    // 3-trial Wilson-derived confidence sits ~0.10–0.13 in our setup.
    // Pick thresholds that bracket that: high=0.5, low=0.001.
    const thresholds: CycleThresholds = {
      min_trials: 3,
      max_trials: 10,
      high: 0.5,
      low: 0.001,
    };

    const report = await runCycle({
      store, collector, runner, executor, runtimes: [], thresholds,
    });

    const outcome = report.candidates[0]?.outcome;
    expect(outcome?.status).toBe('awaiting_more_trials');
    if (outcome?.status === 'awaiting_more_trials') {
      expect(outcome.reason).toBe('mid_confidence');
      expect(outcome.confidence).toBeLessThan(thresholds.high);
      expect(outcome.confidence).toBeGreaterThanOrEqual(thresholds.low);
    }
    // No state change
    expect(store.get(id)?.state).toBe('validating');
  });

  it('low confidence + non-fatal → needs_human_review (no transition, no persistence)', async () => {
    const { id } = provisionValidating(store, 'low');
    // 3 successful trials, but we set low=high=very high so confidence < low → human review
    for (let i = 0; i < 3; i++) {
      collector.record(mkTrial(id, `s${i}`, 0.7, true), true);
    }
    collector.flush();

    const thresholds: CycleThresholds = {
      min_trials: 3,
      max_trials: 10,
      high: 0.999,
      low: 0.998, // 3/3 Wilson ~0.44 < 0.998 → low bucket
    };

    const report = await runCycle({
      store, collector, runner, executor, runtimes: [], thresholds,
    });

    const outcome = report.candidates[0]?.outcome;
    expect(outcome?.status).toBe('needs_human_review');
    if (outcome?.status === 'needs_human_review') {
      expect(outcome.reason).toBe('low_confidence');
    }
    // T-058a constraint: needs_human_review is REPORT-ONLY, no state mutation
    expect(store.get(id)?.state).toBe('validating');
  });

  it('FAIL verdict bypasses confidence gating (always retires)', async () => {
    const { id } = provisionValidating(store, 'fail-bypass');
    for (let i = 0; i < 3; i++) {
      collector.record(mkTrial(id, `s${i}`, 0.1, false), true);
    }
    collector.flush();

    // Even with extremely high `low` threshold, FAIL must still terminate.
    const thresholds: CycleThresholds = {
      min_trials: 3, max_trials: 10, high: 0.999, low: 0.999,
    };

    const report = await runCycle({
      store, collector, runner, executor, runtimes: [], thresholds,
    });

    expect(report.candidates[0]?.outcome.status).toBe('retired');
    expect(store.get(id)?.state).toBe('retired');
  });
});

describe('runCycle :: dryRun', () => {
  it('does not write graduation files or transition state in dryRun', async () => {
    const { id } = provisionValidating(store, 'dry');
    for (let i = 0; i < 10; i++) {
      collector.record(mkTrial(id, `s${i}`, 0.95, true), true);
    }
    collector.flush();

    const report = await runCycle({
      store, collector, runner, executor,
      runtimes: [],
      thresholds: DEFAULT_THRESHOLDS,
      baselineProvider: () => [0.5, 0.55, 0.5, 0.6, 0.5],
      judge: () => 'pass',
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.candidates[0]?.outcome.status).toBe('graduated');
    // BUT no actual mutation
    expect(store.get(id)?.state).toBe('validating');
    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(agentsContent).not.toMatch(/<!--\s*graduated:sha256:/);
  });
});

describe('runCycle :: unknown runtime tolerance', () => {
  it('records unknown runtimes as errors and continues', async () => {
    const report = await runCycle({
      store, collector, runner, executor,
      runtimes: ['nonexistent-runtime-xyz'],
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]?.runtime).toBe('nonexistent-runtime-xyz');
    // No crash
    expect(report.candidates).toHaveLength(0);
  });
});
