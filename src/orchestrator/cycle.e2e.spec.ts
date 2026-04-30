// src/orchestrator/cycle.e2e.spec.ts
//
// T-058a · End-to-end integration: events → ShadowRunner → trial → evaluator →
// graduation, all driven through runCycle() with no shortcuts past the
// matcher / collector / executor layers.
//
// Adapter discovery is bypassed (runtimes:[]) since registering a fake
// RuntimeAdapter via the three-tier registry is filesystem-heavy; events are
// fed directly into ShadowRunner.observe(). All other layers run real code.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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
} from '../kernel/types.js';
import type { SessionEvent } from '../kernel/schemas/session.js';

import { runCycle, type CycleThresholds } from './cycle.js';

const ENV: EnvFingerprint = {
  runtime: 'openclaw',
  platform: 'linux',
  arch: 'x64',
  model: 'claude-opus-4.7',
};

const MIG_DIR = new URL('../store/migrations', import.meta.url).pathname;

function mkEvent(
  type: SessionEvent['type'],
  content: string,
  metadata: Record<string, unknown> = {},
): SessionEvent {
  return { type, timestamp: new Date(), content, metadata };
}

let tmpDir: string;
let store: CandidateStore;
let collector: TrialCollector;
let runner: ShadowRunner;
let executor: GraduationExecutor;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cycle-e2e-'));
  store = new CandidateStore({
    dbPath: join(tmpDir, 't.db'),
    migrationsDir: MIG_DIR,
  });
  collector = new TrialCollector({ store, batchSize: 1 });
  runner = new ShadowRunner({ store, collector });

  workspaceDir = join(tmpDir, 'ws');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, 'AGENTS.md'), '# AGENTS.md\n\noriginal\n', 'utf8');

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

describe('runCycle :: e2e (real shadow + matcher + evaluator + graduation)', () => {
  it('end-to-end: events → trials → evaluator → retire path (FAIL_L2 with shadow-only metrics)', async () => {
    // -------- Setup: validating candidate that matches "tmp file cleanup" events --------
    const baseStrategy = {
      problem_category: 'file_cleanup',
      trigger_conditions: 'temporary files remain in /tmp after subagent task completes',
      recommended_action: 'run cleanup rm -f /tmp/prefix-*',
    };
    const strategy: Strategy = {
      ...baseStrategy,
      strategy_id: computeStrategyId(baseStrategy),
      scope: 'general',
      tags: ['cleanup'],
      summary: 'Clean up tmp files left behind by subagents',
      created_at: new Date().toISOString(),
      instance_ids: [],
    };
    const baseInstance = {
      strategy_id: strategy.strategy_id,
      diff_summary: 'add cleanup rm -f /tmp/prefix-*',
      env_fingerprint: ENV,
    };
    const instance: Instance = {
      ...baseInstance,
      instance_id: computeInstanceId(baseInstance),
      files_touched: ['AGENTS.md'],
      source_sessions: [
        { session_id: 's-orig', runtime: 'openclaw', timestamp: new Date().toISOString() },
      ],
      assertions: [
        { type: 'command_exit_code', command: 'test ! -f /tmp/foo', expected_exit_code: 0 },
      ],
      trial_results: [],
      created_at: new Date().toISOString(),
    };
    store.create({ strategy, instances: [instance], initialState: 'pending' });
    store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
    store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');

    // -------- Drive 10 sessions with events that should match (cleanup + tmp + files) --------
    for (let i = 0; i < 10; i++) {
      const events: SessionEvent[] = [
        mkEvent('user_message', `please clean up the temporary files in /tmp/prefix-${i}`),
        mkEvent('tool_call', `ls /tmp/prefix-${i}`, { tool_name: 'exec' }),
        mkEvent(
          'tool_result',
          `found 3 temporary files in /tmp/prefix-${i}, ready for cleanup with rm`,
        ),
      ];
      runner.observe(`sess-${i}`, events, ENV);
    }
    collector.flush();

    // Sanity: collector picked up trials
    const stats = collector.getStats(strategy.strategy_id);
    expect(stats.trial_count).toBeGreaterThanOrEqual(3);

    // -------- Run cycle --------
    // ShadowRunner records trials with completion_rate=0 (Phase 1a: no L1
    // sandbox execution in the orchestrator path). Combined with a positive
    // baseline this produces a strong negative L2 delta → row 9 (L1=skipped,
    // L2=fail) → FAIL_L2 → retired. This validates the *full failure path*
    // through the orchestrator without bypassing any layer.
    const thresholds: CycleThresholds = {
      min_trials: 3,
      max_trials: 20,
      high: 0.10,
      low: 0.05,
    };

    const report = await runCycle({
      store,
      collector,
      runner,
      executor,
      runtimes: [],          // skip adapter discovery; events already observed
      thresholds,
      baselineProvider: () => [0.5, 0.55, 0.5, 0.6, 0.5],
      judge: () => 'pass',  // L3=pass shouldn't rescue a FAIL_L2
    });

    // ---- Report-level invariants ----
    expect(report.errors).toEqual([]);
    expect(report.candidates).toHaveLength(1);
    const outcome = report.candidates[0]?.outcome;
    // FAIL_L2 → retired (terminal verdict, bypasses confidence gating)
    expect(outcome?.status).toBe('retired');
    if (outcome?.status === 'retired') {
      expect(outcome.verdict).toBe('FAIL_L2');
    }

    // ---- AGENTS.md untouched (no graduation) ----
    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(agentsContent).not.toMatch(/<!--\s*graduated:sha256:/);
    expect(agentsContent).toBe('# AGENTS.md\n\noriginal\n');

    // ---- No graduation audit / body files ----
    const auditGradDir = join(tmpDir, 'audit', 'graduations');
    if (existsSync(auditGradDir)) {
      expect(readdirSync(auditGradDir)).toEqual([]);
    }

    // ---- State actually transitioned to retired ----
    expect(store.get(strategy.strategy_id)?.state).toBe('retired');
  });

  it('end-to-end: high-confidence pre-recorded trials → graduated artefacts', async () => {
    // This test bypasses ShadowRunner (which doesn't fill assertions in P1a)
    // by directly recording fully-populated trials, then runs the rest of
    // the orchestrator pipeline. Validates the graduation artefact chain.

    const baseStrategy = {
      problem_category: 'tmp_cleanup_v2',
      trigger_conditions: 'tmp leftovers',
      recommended_action: 'rm -f /tmp/leftover-*',
    };
    const strategy: Strategy = {
      ...baseStrategy,
      strategy_id: computeStrategyId(baseStrategy),
      scope: 'general',
      summary: 'Clean tmp leftovers',
      created_at: new Date().toISOString(),
      instance_ids: [],
    };
    const baseInstance = {
      strategy_id: strategy.strategy_id,
      diff_summary: 'add cleanup',
      env_fingerprint: ENV,
    };
    const instance: Instance = {
      ...baseInstance,
      instance_id: computeInstanceId(baseInstance),
      files_touched: ['AGENTS.md'],
      source_sessions: [
        { session_id: 's-1', runtime: 'openclaw', timestamp: new Date().toISOString() },
      ],
      assertions: [
        { type: 'command_exit_code', command: 'true', expected_exit_code: 0 },
      ],
      trial_results: [],
      created_at: new Date().toISOString(),
    };
    store.create({ strategy, instances: [instance], initialState: 'pending' });
    store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
    store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');

    for (let i = 0; i < 10; i++) {
      collector.record(
        {
          trial_id: `t-${i}`,
          candidate_id: strategy.strategy_id,
          session_id: `s-${i}`,
          runtime: 'openclaw',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          assertions: [
            { type: 'command_exit_code', status: 'pass', actual_exit_code: 0 },
          ],
          metrics: { turns: 5, errors: 0, token_usage: 1000, completion_rate: 0.95 },
          env_fingerprint: ENV,
        },
        true,
      );
    }
    collector.flush();

    const report = await runCycle({
      store, collector, runner, executor,
      runtimes: [],
      thresholds: { min_trials: 3, max_trials: 20, high: 0.10, low: 0.05 },
      baselineProvider: () => [0.5, 0.55, 0.5, 0.6, 0.5],
      judge: () => 'pass',
    });

    expect(report.errors).toEqual([]);
    const outcome = report.candidates[0]?.outcome;
    expect(outcome?.status).toBe('graduated');

    // Real artefacts
    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf8');
    expect(agentsContent).toMatch(/<!--\s*graduated:sha256:[a-f0-9]{64}\s+start\s*-->/);
    expect(agentsContent).toContain('tmp_cleanup_v2');

    const auditFiles = readdirSync(join(tmpDir, 'audit', 'graduations'));
    expect(auditFiles.length).toBe(1);
    expect(
      readFileSync(join(tmpDir, 'audit', 'graduations', auditFiles[0]!), 'utf8'),
    ).toContain('marker_block');

    const bodyFiles = readdirSync(join(tmpDir, 'graduated')).filter((f) => f.endsWith('.md'));
    expect(bodyFiles.length).toBe(1);

    expect(store.get(strategy.strategy_id)?.state).toBe('graduated');
  });
});
