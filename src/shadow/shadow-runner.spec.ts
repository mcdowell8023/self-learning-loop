// src/shadow/shadow-runner.spec.ts
//
// T-P1a-006 · Shadow Runner 单元测试
//
// 覆盖（DoD §14.1 #9 + #10）：
//   1. 匹配 happy / miss
//   2. 批量收集（TrialCollector.batchSize）
//   3. 多候选并发观察
//   4. 非 validating 状态不处理（pending/reviewing/dormant/graduated/retired/rejected）
//   5. scope 粗筛正确性（general / tool:* / role:* / skill）
//   6. keyword 细筛阈值（minKeywordHits）
//   7. recordMisses 选项
//   8. stats 聚合（trial_count / match_count / by_session）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateStore } from '../store/candidate-store.js';
import { computeStrategyId } from '../kernel/content-id.js';
import type {
  CandidateScope,
  CandidateState,
  DormantReason,
  EnvFingerprint,
  Strategy,
} from '../kernel/types.js';
import type { SessionEvent } from '../reflect/reflection-prompt.js';

import { ShadowRunner } from './shadow-runner.js';
import { TrialCollector } from './trial-collector.js';
import {
  coarseMatch,
  extractKeywords,
  matchSession,
  DEFAULT_MATCHER_CONFIG,
} from './matcher.js';

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

function mkStrategy(overrides: Partial<Strategy> = {}): Strategy {
  const base = {
    problem_category: overrides.problem_category ?? 'file_cleanup',
    trigger_conditions:
      overrides.trigger_conditions ??
      'temporary files remain in /tmp after subagent task completes',
    recommended_action:
      overrides.recommended_action ?? 'run cleanup rm -f /tmp/prefix-*',
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

function persistCandidate(
  store: CandidateStore,
  strategy: Strategy,
  state: CandidateState,
  dormantReason?: DormantReason,
): void {
  // 所有状态都先从 pending 创建，再走合法 transition 到目标态
  store.create({ strategy, initialState: 'pending' });
  const id = strategy.strategy_id;

  if (state === 'pending') return;

  // pending → reviewing
  store.transition(id, 'pending', 'reviewing', 'start_review');
  if (state === 'reviewing') return;

  if (state === 'rejected') {
    store.transition(id, 'reviewing', 'rejected', 'review_failed');
    return;
  }

  // reviewing → validating
  store.transition(id, 'reviewing', 'validating', 'review_passed');
  if (state === 'validating') return;

  if (state === 'graduated') {
    store.transition(id, 'validating', 'graduated', 'graduate');
    return;
  }
  if (state === 'retired') {
    store.transition(id, 'validating', 'retired', 'retire');
    return;
  }
  if (state === 'conflict') {
    store.transition(id, 'validating', 'conflict', 'enter_conflict');
    return;
  }
  if (state === 'dormant') {
    store.transition(id, 'validating', 'dormant', 'enter_dormant', {
      dormantReason: dormantReason ?? 'no_match',
    });
    return;
  }
}

function mkEvent(
  type: SessionEvent['type'],
  content: string,
  metadata: Record<string, unknown> = {},
): SessionEvent {
  return {
    type,
    timestamp: new Date(),
    content,
    metadata,
  };
}

// Events that will match the default strategy (contains "temporary", "files", "/tmp")
const MATCHING_EVENTS: SessionEvent[] = [
  mkEvent('user_message', 'please clean up the temporary files from last run'),
  mkEvent('tool_call', 'ls /tmp/prefix-abc', { tool_name: 'exec' }),
  mkEvent(
    'tool_result',
    'found 12 temporary files in /tmp/prefix-*, ready for cleanup',
  ),
];

const NON_MATCHING_EVENTS: SessionEvent[] = [
  mkEvent('user_message', 'compile the typescript project and run tests'),
  mkEvent('tool_call', 'npm run build', { tool_name: 'exec' }),
  mkEvent('tool_result', 'compiled successfully without warnings'),
];

let tmpDir: string;
let store: CandidateStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'shadow-runner-test-'));
  store = new CandidateStore({
    dbPath: join(tmpDir, 'test.db'),
    migrationsDir: MIG_DIR,
  });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// matcher.ts 单元测试
// ===========================================================================

describe('matcher.extractKeywords', () => {
  it('extracts ASCII tokens and filters stopwords', () => {
    const kws = extractKeywords(
      'the temporary files should be cleaned from /tmp directory',
    );
    // 'the', 'should', 'be' 是停用词 / <3；'tmp' 会是单独一个（3 字符刚好保留）
    expect(kws).toContain('temporary');
    expect(kws).toContain('files');
    expect(kws).toContain('cleaned');
    expect(kws).toContain('directory');
    expect(kws).not.toContain('the');
    expect(kws).not.toContain('be');
  });

  it('extracts CJK segments of length >= 2', () => {
    const kws = extractKeywords('临时文件清理任务完成后需要删除');
    // 整个连续中文会被当成一个 token（Phase 1a 未分词）
    expect(kws.some((k) => /[\u4e00-\u9fff]/.test(k))).toBe(true);
  });

  it('respects maxKeywords cap', () => {
    const text = Array.from({ length: 50 }, (_, i) => `word${i + 1000}`).join(' ');
    const kws = extractKeywords(text, { ...DEFAULT_MATCHER_CONFIG, maxKeywords: 5 });
    expect(kws.length).toBe(5);
  });

  it('returns empty for empty input', () => {
    expect(extractKeywords('')).toEqual([]);
  });
});

describe('matcher.coarseMatch', () => {
  it('scope=general always passes (non-empty events)', () => {
    expect(coarseMatch('general', MATCHING_EVENTS).passed).toBe(true);
  });

  it('scope=tool:X requires a tool_call with that name', () => {
    const events: SessionEvent[] = [
      mkEvent('tool_call', 'read file', { tool_name: 'read' }),
    ];
    expect(coarseMatch('tool:read' as CandidateScope, events).passed).toBe(true);
    expect(coarseMatch('tool:write' as CandidateScope, events).passed).toBe(false);
  });

  it('scope=role:X matches metadata.role', () => {
    const events: SessionEvent[] = [
      mkEvent('system', 'subagent spawned', { role: 'luban' }),
    ];
    expect(coarseMatch('role:luban' as CandidateScope, events).passed).toBe(true);
    expect(coarseMatch('role:jiyun' as CandidateScope, events).passed).toBe(false);
  });

  it('scope=skill matches metadata.skill or "skill:" prefix', () => {
    const events: SessionEvent[] = [
      mkEvent('system', 'using skill: web-search', { skill: 'web-search' }),
    ];
    expect(coarseMatch('skill', events).passed).toBe(true);
  });
});

describe('matcher.matchSession', () => {
  it('returns matched=true when scope passes and >= minKeywordHits keywords match', () => {
    const strategy = mkStrategy();
    const result = matchSession(strategy, MATCHING_EVENTS);
    expect(result.matched).toBe(true);
    expect(result.coarsePassed).toBe(true);
    expect(result.matchedKeywords.length).toBeGreaterThanOrEqual(2);
  });

  it('returns matched=false when keywords do not hit', () => {
    const strategy = mkStrategy();
    const result = matchSession(strategy, NON_MATCHING_EVENTS);
    expect(result.matched).toBe(false);
    expect(result.coarsePassed).toBe(true); // general scope
    expect(result.matchedKeywords.length).toBeLessThan(
      DEFAULT_MATCHER_CONFIG.minKeywordHits,
    );
  });

  it('returns matched=false when scope coarse filter rejects', () => {
    const strategy = mkStrategy({ scope: 'tool:nonexistent_tool' as CandidateScope });
    const result = matchSession(strategy, MATCHING_EVENTS);
    expect(result.matched).toBe(false);
    expect(result.coarsePassed).toBe(false);
    expect(result.reason).toMatch(/scope=tool/);
  });

  it('returns matched=false on empty events', () => {
    const strategy = mkStrategy();
    const result = matchSession(strategy, []);
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });
});

// ===========================================================================
// ShadowRunner 集成测试
// ===========================================================================

describe('ShadowRunner.observe', () => {
  it('records trial when validating candidate matches session', () => {
    const strategy = mkStrategy();
    persistCandidate(store, strategy, 'validating');

    const runner = new ShadowRunner({
      store,
      collector: new TrialCollector({ store, batchSize: 1 }),
    });
    const report = runner.observe('sess-1', MATCHING_EVENTS, ENV);

    expect(report.candidatesChecked).toBe(1);
    expect(report.matchedCount).toBe(1);
    expect(report.trialsWritten).toBe(1);
    expect(report.perCandidate[0]!.matched).toBe(true);
    expect(report.perCandidate[0]!.trial_id).toMatch(/^trial-/);

    const stats = runner.getCollector().getStats(strategy.strategy_id);
    expect(stats.trial_count).toBe(1);
    expect(stats.match_count).toBe(1);
    expect(stats.by_session['sess-1']).toBe(1);
  });

  it('does NOT record trial when session does not match (default behavior)', () => {
    const strategy = mkStrategy();
    persistCandidate(store, strategy, 'validating');

    const runner = new ShadowRunner({ store });
    const report = runner.observe('sess-1', NON_MATCHING_EVENTS, ENV);

    expect(report.candidatesChecked).toBe(1);
    expect(report.matchedCount).toBe(0);
    expect(report.trialsWritten).toBe(0);
    expect(report.perCandidate[0]!.matched).toBe(false);

    const stats = runner.getCollector().getStats(strategy.strategy_id);
    expect(stats.trial_count).toBe(0);
  });

  it('records misses when recordMisses=true', () => {
    const strategy = mkStrategy();
    persistCandidate(store, strategy, 'validating');

    const runner = new ShadowRunner({
      store,
      collector: new TrialCollector({ store, batchSize: 1 }),
      recordMisses: true,
    });
    const report = runner.observe('sess-1', NON_MATCHING_EVENTS, ENV);

    expect(report.matchedCount).toBe(0);
    expect(report.trialsWritten).toBe(1); // miss recorded

    const stats = runner.getCollector().getStats(strategy.strategy_id);
    expect(stats.trial_count).toBe(1);
    expect(stats.match_count).toBe(0);
  });

  it('skips non-validating candidates (all other states)', () => {
    const states: Array<{ state: CandidateState; reason?: DormantReason }> = [
      { state: 'pending' },
      { state: 'reviewing' },
      { state: 'rejected' },
      { state: 'graduated' },
      { state: 'retired' },
      { state: 'conflict' },
      { state: 'dormant', reason: 'no_match' },
    ];

    for (const [i, s] of states.entries()) {
      const strategy = mkStrategy({
        strategy_id: `sha256:fake-${i}-${s.state}`,
        problem_category: `cat-${i}`,
      });
      persistCandidate(store, strategy, s.state, s.reason);
    }

    // And one validating to confirm it DOES run
    const active = mkStrategy({
      strategy_id: 'sha256:active-validating',
      problem_category: 'active',
    });
    persistCandidate(store, active, 'validating');

    const runner = new ShadowRunner({
      store,
      collector: new TrialCollector({ store, batchSize: 1 }),
    });
    const report = runner.observe('sess-1', MATCHING_EVENTS, ENV);

    // Only the validating candidate is checked (list(state=validating))
    expect(report.candidatesChecked).toBe(1);
    expect(report.perCandidate[0]!.candidate_id).toBe('sha256:active-validating');
  });

  it('handles multiple validating candidates concurrently', () => {
    const s1 = mkStrategy({
      strategy_id: 'sha256:c1',
      problem_category: 'cleanup',
      trigger_conditions: 'temporary files remain in /tmp',
    });
    const s2 = mkStrategy({
      strategy_id: 'sha256:c2',
      problem_category: 'testing',
      trigger_conditions: 'compile typescript project and run tests',
    });
    const s3 = mkStrategy({
      strategy_id: 'sha256:c3',
      problem_category: 'other',
      trigger_conditions: 'deploy production server kubernetes cluster',
    });
    persistCandidate(store, s1, 'validating');
    persistCandidate(store, s2, 'validating');
    persistCandidate(store, s3, 'validating');

    const runner = new ShadowRunner({
      store,
      collector: new TrialCollector({ store, batchSize: 1 }),
    });
    // NON_MATCHING_EVENTS talks about "compile typescript project run tests" → matches s2
    const report = runner.observe('sess-1', NON_MATCHING_EVENTS, ENV);

    expect(report.candidatesChecked).toBe(3);
    const byId = new Map(
      report.perCandidate.map((p) => [p.candidate_id, p.matched]),
    );
    expect(byId.get('sha256:c1')).toBe(false);
    expect(byId.get('sha256:c2')).toBe(true);
    expect(byId.get('sha256:c3')).toBe(false);
    expect(report.matchedCount).toBe(1);
    expect(report.trialsWritten).toBe(1);
  });

  it('batches trials via TrialCollector.batchSize and flushes on observe boundary', () => {
    // 5 validating candidates all matching, batchSize=3 → first 3 flushed auto,
    // remaining 2 stays in buffer until explicit flush
    const strategies = Array.from({ length: 5 }, (_, i) =>
      mkStrategy({
        strategy_id: `sha256:batch-${i}`,
        problem_category: `cat-${i}`,
      }),
    );
    for (const s of strategies) persistCandidate(store, s, 'validating');

    const collector = new TrialCollector({ store, batchSize: 3 });
    const runner = new ShadowRunner({ store, collector });
    const report = runner.observe('sess-1', MATCHING_EVENTS, ENV);

    expect(report.trialsWritten).toBe(5);

    // After observe: 3 auto-flushed (first triggering record returned true),
    // leaving 2 in buffer. Verify by querying BEFORE flush.
    expect(collector._bufferSize()).toBe(2);

    // Manually flush and check total persisted count via SQL
    const flushed = runner.flush();
    expect(flushed).toBe(2);
    expect(collector._bufferSize()).toBe(0);

    const totalRow = store
      ._unsafeDb()
      .prepare(`SELECT COUNT(*) AS n FROM trial_results`)
      .get() as { n: number };
    expect(totalRow.n).toBe(5);
  });

  it('aggregates stats by session across multiple observe calls', () => {
    const strategy = mkStrategy();
    persistCandidate(store, strategy, 'validating');
    const runner = new ShadowRunner({
      store,
      collector: new TrialCollector({ store, batchSize: 1 }),
    });

    runner.observe('sess-A', MATCHING_EVENTS, ENV);
    runner.observe('sess-A', MATCHING_EVENTS, ENV);
    runner.observe('sess-B', MATCHING_EVENTS, ENV);

    const stats = runner.getCollector().getStats(strategy.strategy_id);
    expect(stats.trial_count).toBe(3);
    expect(stats.match_count).toBe(3);
    expect(stats.by_session['sess-A']).toBe(2);
    expect(stats.by_session['sess-B']).toBe(1);
  });

  it('uses custom trialIdFactory when provided', () => {
    const strategy = mkStrategy();
    persistCandidate(store, strategy, 'validating');

    let seq = 0;
    const runner = new ShadowRunner({
      store,
      collector: new TrialCollector({ store, batchSize: 1 }),
      trialIdFactory: () => `custom-trial-${++seq}`,
    });
    const report = runner.observe('sess-1', MATCHING_EVENTS, ENV);
    expect(report.perCandidate[0]!.trial_id).toBe('custom-trial-1');
  });

  it('TrialResult has secure_l1_evidence=undefined (Phase 1a placeholder)', () => {
    const strategy = mkStrategy();
    persistCandidate(store, strategy, 'validating');
    const runner = new ShadowRunner({
      store,
      collector: new TrialCollector({ store, batchSize: 1 }),
    });
    runner.observe('sess-1', MATCHING_EVENTS, ENV);

    const trials = runner
      .getCollector()
      .listTrials(strategy.strategy_id);
    expect(trials.length).toBe(1);
    expect(trials[0]!.secure_l1_evidence).toBeUndefined();
    expect(trials[0]!.env_fingerprint.runtime).toBe('openclaw');
    expect(trials[0]!.runtime).toBe('openclaw');
  });

  it('matcherConfig override lowers minKeywordHits threshold', () => {
    const strategy = mkStrategy({
      trigger_conditions: 'xylophone',  // only 1 unique keyword
    });
    persistCandidate(store, strategy, 'validating');

    const events: SessionEvent[] = [mkEvent('user_message', 'play the xylophone')];

    // Default minKeywordHits=2 → no match
    const runner1 = new ShadowRunner({
      store,
      collector: new TrialCollector({ store, batchSize: 1 }),
    });
    expect(runner1.observe('s', events, ENV).matchedCount).toBe(0);

    // Lowered to 1 → match
    const runner2 = new ShadowRunner({
      store,
      collector: new TrialCollector({ store, batchSize: 1 }),
      matcherConfig: { minKeywordHits: 1 },
    });
    expect(runner2.observe('s', events, ENV).matchedCount).toBe(1);
  });
});
