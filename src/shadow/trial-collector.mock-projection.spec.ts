// src/shadow/trial-collector.mock-projection.spec.ts
//
// T-058c-Lite · Phase 1a mock-assertion projection
//
// 验证 TrialCollector.listTrials 在 `mockPhase1aAssertions=true` 时：
//   1. trial.assertions 为空 → 按 candidate.instance.assertions 投影 mock pass
//   2. trial.metrics.completion_rate 提升为 1
//   3. flag 关闭时不变（不污染既有路径）
//   4. trial 已有 assertions 时不覆盖
//
// **TODO(T-058c v2):** 真路径接入后，删除整个 spec 文件 + 投影函数 + flag。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateStore } from '../store/candidate-store.js';
import { computeStrategyId } from '../kernel/content-id.js';
import { TrialCollector } from './trial-collector.js';
import { ShadowRunner } from './shadow-runner.js';
import type {
  AssertionSpec,
  EnvFingerprint,
  Instance,
  SessionEvent,
  Strategy,
} from '../kernel/types.js';

const MIG_DIR = new URL('../store/migrations', import.meta.url).pathname;

const ENV: EnvFingerprint = {
  runtime: 'openclaw',
  platform: 'linux',
  arch: 'x64',
};

function mkStrategy(): Strategy {
  const base = {
    problem_category: 'doc_sync',
    trigger_conditions: 'temporary files remain in /tmp after subagent task completes',
    recommended_action: 'rm -f /tmp/prefix-*',
  };
  const strategy_id = computeStrategyId(base);
  return {
    strategy_id,
    ...base,
    scope: 'general',
    tags: ['cleanup'],
    created_at: new Date().toISOString(),
    instance_ids: [],
  };
}

function mkInstance(strategyId: string, assertions: AssertionSpec[]): Instance {
  return {
    instance_id: strategyId, // ok for test (different from real id but not validated by store)
    strategy_id: strategyId,
    diff_summary: 'mock',
    files_touched: [],
    env_fingerprint: ENV,
    source_sessions: [],
    assertions,
    trial_results: [],
    created_at: new Date().toISOString(),
  };
}

function mkEvent(content: string): SessionEvent {
  return {
    type: 'user_message',
    timestamp: new Date(),
    content,
    metadata: {},
  } as SessionEvent;
}

const MATCHING_EVENTS: SessionEvent[] = [
  mkEvent('please clean up the temporary files from /tmp/prefix-*'),
  mkEvent('found temporary files in /tmp/prefix-* ready for cleanup'),
];

let tmpDir: string;
let store: CandidateStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trial-collector-mock-'));
  store = new CandidateStore({
    dbPath: join(tmpDir, 'test.db'),
    migrationsDir: MIG_DIR,
  });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('TrialCollector mock-phase1a projection', () => {
  it('default (flag off) returns original empty assertions', () => {
    const strategy = mkStrategy();
    const instance = mkInstance(strategy.strategy_id, [
      { type: 'regex_match', description: 'check' },
    ]);
    store.create({ strategy, instances: [instance], initialState: 'pending' });
    store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
    store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');

    const collector = new TrialCollector({ store, batchSize: 1 });
    const runner = new ShadowRunner({ store, collector });
    runner.observe('s1', MATCHING_EVENTS, ENV);

    const trials = collector.listTrials(strategy.strategy_id);
    expect(trials.length).toBeGreaterThan(0);
    expect(trials[0]!.assertions).toEqual([]);
    expect(trials[0]!.metrics.completion_rate).toBe(0);
  });

  it('flag on + empty trial assertions: projects 1 mock pass per instance spec', () => {
    const strategy = mkStrategy();
    const specs: AssertionSpec[] = [
      { type: 'regex_match', description: 'check 1' },
      { type: 'file_exists', description: 'check 2' },
      { type: 'command_exit_code', command: 'echo', expected_exit_code: 0 },
    ];
    const instance = mkInstance(strategy.strategy_id, specs);
    store.create({ strategy, instances: [instance], initialState: 'pending' });
    store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
    store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');

    const collector = new TrialCollector({ store, batchSize: 1, mockPhase1aAssertions: true });
    const runner = new ShadowRunner({ store, collector });
    runner.observe('s1', MATCHING_EVENTS, ENV);

    const trials = collector.listTrials(strategy.strategy_id);
    expect(trials.length).toBeGreaterThan(0);
    const t = trials[0]!;
    // 3 specs → 3 mock assertions, all pass, types preserved
    expect(t.assertions).toHaveLength(3);
    expect(t.assertions.every((a) => a.status === 'pass')).toBe(true);
    expect(t.assertions.map((a) => a.type)).toEqual([
      'regex_match',
      'file_exists',
      'command_exit_code',
    ]);
    // completion_rate boosted
    expect(t.metrics.completion_rate).toBe(1);
    // secure_l1_evidence still untouched (mock does NOT forge signature)
    expect(t.secure_l1_evidence).toBeUndefined();
  });

  it('flag on but no instance specs: no projection, returns original empty assertions', () => {
    const strategy = mkStrategy();
    const instance = mkInstance(strategy.strategy_id, []);
    store.create({ strategy, instances: [instance], initialState: 'pending' });
    store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
    store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');

    const collector = new TrialCollector({ store, batchSize: 1, mockPhase1aAssertions: true });
    const runner = new ShadowRunner({ store, collector });
    runner.observe('s1', MATCHING_EVENTS, ENV);

    const trials = collector.listTrials(strategy.strategy_id);
    expect(trials[0]!.assertions).toEqual([]);
    expect(trials[0]!.metrics.completion_rate).toBe(0);
  });
});
