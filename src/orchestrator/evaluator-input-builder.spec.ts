// src/orchestrator/evaluator-input-builder.spec.ts
//
// T-058a · EvaluatorInput Plumbing — unit tests
//
// 覆盖：
//   1. happy path：从 store/collector 组装出 evaluator 可消费的 input
//   2. trial metric 抽取（completion_rate 默认）+ 自定义 extractor
//   3. baseline 缺省 → 空数组（L2 走 skipped/zero-variance）
//   4. judge 注入：返回的 L3Signal 被传入 input.l3
//   5. judge 抛错 → 降级为 'skipped'，不传染（plan §A2）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateStore } from '../store/candidate-store.js';
import { TrialCollector } from '../shadow/trial-collector.js';
import { computeStrategyId, computeInstanceId } from '../kernel/content-id.js';
import type {
  EnvFingerprint,
  Instance,
  Strategy,
  TrialResult,
} from '../kernel/types.js';

import { buildEvaluatorInput } from './evaluator-input-builder.js';

// ---------------------------------------------------------------------------
// Helpers (aligned with src/store/candidate-store.spec.ts conventions)
// ---------------------------------------------------------------------------

const ENV: EnvFingerprint = {
  runtime: 'openclaw',
  platform: 'linux',
  arch: 'x64',
  model: 'claude-opus-4.7',
};

const MIG_DIR = new URL('../store/migrations', import.meta.url).pathname;

function mkStrategy(): Strategy {
  const base = {
    problem_category: 'file_cleanup',
    trigger_conditions: 'temporary files remain in /tmp after task completes',
    recommended_action: 'rm -f /tmp/prefix-*',
  };
  return {
    strategy_id: computeStrategyId(base),
    problem_category: base.problem_category,
    trigger_conditions: base.trigger_conditions,
    recommended_action: base.recommended_action,
    scope: 'general',
    tags: ['cleanup'],
    created_at: new Date().toISOString(),
    instance_ids: [],
  };
}

function mkInstance(strategyId: string): Instance {
  const base = {
    strategy_id: strategyId,
    diff_summary: 'added cleanup',
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
      { type: 'command_exit_code', command: 'test ! -f /tmp/x', expected_exit_code: 0 },
    ],
    trial_results: [],
    created_at: new Date().toISOString(),
  };
}

function mkTrial(
  candidateId: string,
  sessionId: string,
  completionRate: number,
  matched = true,
): TrialResult {
  return {
    trial_id: `trial-${sessionId}`,
    candidate_id: candidateId,
    session_id: sessionId,
    runtime: 'openclaw',
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    assertions: matched
      ? [{ type: 'command_exit_code', status: 'pass', actual_exit_code: 0 }]
      : [],
    metrics: {
      turns: 5,
      errors: 0,
      token_usage: 1000,
      completion_rate: completionRate,
    },
    env_fingerprint: ENV,
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDir: string;
let store: CandidateStore;
let collector: TrialCollector;
let strategy: Strategy;
let candidateId: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'eib-test-'));
  store = new CandidateStore({
    dbPath: join(tmpDir, 't.db'),
    migrationsDir: MIG_DIR,
  });
  collector = new TrialCollector({ store, batchSize: 1 });

  strategy = mkStrategy();
  candidateId = strategy.strategy_id;
  const inst = mkInstance(candidateId);
  store.create({ strategy, instances: [inst], initialState: 'pending' });
  // pending → reviewing → validating
  store.transition(candidateId, 'pending', 'reviewing', 'start_review');
  store.transition(candidateId, 'reviewing', 'validating', 'review_passed');
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildEvaluatorInput', () => {
  it('throws when candidate not found', async () => {
    await expect(
      buildEvaluatorInput('sha256:nonexistent', store, collector),
    ).rejects.toThrow(/not found/);
  });

  it('happy path: assembles assertions + trials + metrics', async () => {
    collector.record(mkTrial(candidateId, 'sess-1', 0.9), true);
    collector.record(mkTrial(candidateId, 'sess-2', 0.85), true);
    collector.flush();

    const input = await buildEvaluatorInput(candidateId, store, collector);

    expect(input.candidate_id).toBe(candidateId);
    expect(input.assertions).toHaveLength(1);
    expect(input.assertions[0]?.type).toBe('command_exit_code');
    expect(input.trials).toHaveLength(2);
    expect(input.metrics.trial).toEqual([0.9, 0.85]);
    expect(input.metrics.baseline).toEqual([]); // no BaselineMetricStore yet
    expect(input.l3).toBeUndefined(); // no judge → undefined (= 'skipped' in evaluator)
  });

  it('honours custom metricExtractor', async () => {
    collector.record(mkTrial(candidateId, 'sess-1', 0.5), true);
    collector.record(mkTrial(candidateId, 'sess-2', 0.7), true);
    collector.flush();

    const input = await buildEvaluatorInput(candidateId, store, collector, {
      metricExtractor: (t) => t.metrics.turns, // extract turns instead
    });

    expect(input.metrics.trial).toEqual([5, 5]);
  });

  it('passes baseline through', async () => {
    collector.record(mkTrial(candidateId, 'sess-1', 0.9), true);
    collector.flush();

    const input = await buildEvaluatorInput(candidateId, store, collector, {
      baseline: [0.6, 0.65, 0.7, 0.55],
    });

    expect(input.metrics.baseline).toEqual([0.6, 0.65, 0.7, 0.55]);
  });

  it('invokes judge and forwards L3Signal', async () => {
    collector.record(mkTrial(candidateId, 'sess-1', 0.95), true);
    collector.flush();

    const input = await buildEvaluatorInput(candidateId, store, collector, {
      judge: () => 'pass',
    });

    expect(input.l3).toBe('pass');
  });

  it('judge async return is awaited', async () => {
    collector.record(mkTrial(candidateId, 'sess-1', 0.95), true);
    collector.flush();

    const input = await buildEvaluatorInput(candidateId, store, collector, {
      judge: async () => 'fail',
    });

    expect(input.l3).toBe('fail');
  });

  it('judge throw → degrades to "skipped" (non-fatal)', async () => {
    collector.record(mkTrial(candidateId, 'sess-1', 0.95), true);
    collector.flush();

    const input = await buildEvaluatorInput(candidateId, store, collector, {
      judge: () => {
        throw new Error('LLM timeout');
      },
    });

    expect(input.l3).toBe('skipped');
  });

  it('filters non-finite metric values', async () => {
    const t = mkTrial(candidateId, 'sess-1', 0.8);
    collector.record(t, true);
    collector.flush();

    const input = await buildEvaluatorInput(candidateId, store, collector, {
      metricExtractor: () => Number.NaN,
    });

    expect(input.metrics.trial).toEqual([]);
  });
});
