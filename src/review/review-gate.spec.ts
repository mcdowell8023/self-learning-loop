// src/review/review-gate.spec.ts
//
// T-P1a-004 单元测试：四维 Review Gate
//
// 覆盖：
//   1. 四维独立 happy-path + edge cases
//   2. 整体编排：全过 → validating；任一失败 → rejected
//   3. 短路语义：metadata fail 时 safety/conflict/semantic 不执行
//   4. Audit log：每维一条 + summary
//   5. 依赖注入：LLM / RulesProvider / StrategyLookup 全部 mockable

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateStore } from '../store/candidate-store.js';
import { computeStrategyId, computeInstanceId } from '../kernel/content-id.js';
import type {
  Candidate,
  EnvFingerprint,
  Instance,
  Strategy,
} from '../kernel/types.js';

import {
  ReviewGate,
  InMemoryAuditSink,
  strategyLookupFromCandidateStore,
  reviewMetadata,
  reviewSafety,
  reviewConflict,
  reviewSemantic,
} from './review-gate.js';
import { DEFAULT_REVIEW_CONFIG, type ReviewGateConfig, type LlmJudge } from './types.js';

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
    trigger_conditions:
      overrides.trigger_conditions ?? 'temporary files remain after subagent task completes',
    recommended_action:
      overrides.recommended_action ?? 'clean /tmp/prefix-* files after task completion',
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
    diff_summary: overrides.diff_summary ?? 'added cleanup rm -f /tmp/x*',
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

const MIG_DIR = new URL('../store/migrations', import.meta.url).pathname;

function makeCandidateObj(strategy: Strategy, instances: Instance[] = []): Candidate {
  return {
    candidate_id: strategy.strategy_id,
    strategy,
    instances,
    state: 'pending',
    dormant_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

let tmpDir: string;
let store: CandidateStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'review-gate-test-'));
  store = new CandidateStore({
    dbPath: join(tmpDir, 'test.db'),
    migrationsDir: MIG_DIR,
  });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function persistCandidate(strategy: Strategy, instances: Instance[] = []): Candidate {
  // Strategy.instance_ids 与 instances 一致
  strategy.instance_ids = instances.map((i) => i.instance_id);
  return store.create({ strategy, instances, initialState: 'pending' });
}

// ===========================================================================
// Dimension: metadata
// ===========================================================================
describe('dimension: metadata', () => {
  const deps = { config: DEFAULT_REVIEW_CONFIG };

  it('happy-path: 完整字段通过', async () => {
    const c = makeCandidateObj(mkStrategy());
    const r = await reviewMetadata(c, deps);
    expect(r.pass).toBe(true);
    expect(r.dimension).toBe('metadata');
    expect(r.salvageable).toBe(false);
  });

  it('edge: 缺失 recommended_action → SCHEMA_INVALID 不可挽救', async () => {
    const s = mkStrategy({ recommended_action: '' });
    const c = makeCandidateObj(s);
    const r = await reviewMetadata(c, deps);
    expect(r.pass).toBe(false);
    expect(r.code).toBe('SCHEMA_INVALID');
    expect(r.salvageable).toBe(false);
    expect(r.reason).toContain('recommended_action');
  });

  it('edge: scope 格式非法', async () => {
    const s = mkStrategy({ scope: 'weird:thing' as unknown as Strategy['scope'] });
    const c = makeCandidateObj(s);
    const r = await reviewMetadata(c, deps);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/invalid_scope_format/);
  });

  it('edge: scope=tool:xxx 合法', async () => {
    const s = mkStrategy({ scope: 'tool:feishu_doc' as Strategy['scope'] });
    const c = makeCandidateObj(s);
    const r = await reviewMetadata(c, deps);
    expect(r.pass).toBe(true);
  });
});

// ===========================================================================
// Dimension: safety
// ===========================================================================
describe('dimension: safety', () => {
  const deps = { config: DEFAULT_REVIEW_CONFIG };

  it('happy-path: 无危险操作通过', async () => {
    const c = makeCandidateObj(
      mkStrategy(),
      [mkInstance(mkStrategy().strategy_id)],
    );
    const r = await reviewSafety(c, deps);
    expect(r.pass).toBe(true);
  });

  it('edge: recommended_action 含 rm -rf /', async () => {
    const s = mkStrategy({ recommended_action: 'run rm -rf / to cleanup' });
    const c = makeCandidateObj(s);
    const r = await reviewSafety(c, deps);
    expect(r.pass).toBe(false);
    expect(r.code).toBe('SAFETY_VIOLATION');
    expect(r.reason).toMatch(/banned_keyword/);
  });

  it('edge: files_touched 含 ~/.ssh/', async () => {
    const s = mkStrategy();
    const inst = mkInstance(s.strategy_id, { files_touched: ['~/.ssh/id_rsa'] });
    const c = makeCandidateObj(s, [inst]);
    const r = await reviewSafety(c, deps);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/sensitive_path/);
  });

  it('edge: 硬编码 OpenAI 密钥', async () => {
    const s = mkStrategy({
      recommended_action: 'use API key sk-abcdef0123456789abcdefABCDEF01 to call',
    });
    const c = makeCandidateObj(s);
    const r = await reviewSafety(c, deps);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/secret_pattern|banned_keyword/);
  });

  it('edge: assertion command_allowlist 含通配符 *', async () => {
    const s = mkStrategy();
    const inst = mkInstance(s.strategy_id, {
      assertions: [
        {
          type: 'command_exit_code',
          command: 'ls',
          command_allowlist: ['*'],
          expected_exit_code: 0,
        },
      ],
    });
    const c = makeCandidateObj(s, [inst]);
    const r = await reviewSafety(c, deps);
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/wildcard_allowlist/);
  });
});

// ===========================================================================
// Dimension: conflict
// ===========================================================================
describe('dimension: conflict', () => {
  it('happy-path: 无 rulesProvider → 直接 pass', async () => {
    const c = makeCandidateObj(mkStrategy());
    const r = await reviewConflict(c, { config: DEFAULT_REVIEW_CONFIG });
    expect(r.pass).toBe(true);
    expect(r.detail?.skipped).toBe('no_rules_provider');
  });

  it('happy-path: keyword 无命中', async () => {
    const c = makeCandidateObj(mkStrategy());
    const r = await reviewConflict(c, {
      config: DEFAULT_REVIEW_CONFIG,
      rulesProvider: {
        getRuleSnippets: async () => ['deploy service via docker compose'],
      },
    });
    expect(r.pass).toBe(true);
  });

  it('edge: keyword 命中 + LLM 判定冲突 → fail 可挽救', async () => {
    const llm: LlmJudge = {
      async judgeConflict() {
        return { conflict: true, reason: 'overlaps with existing cleanup rule' };
      },
    };
    const c = makeCandidateObj(mkStrategy());
    const r = await reviewConflict(c, {
      config: DEFAULT_REVIEW_CONFIG,
      rulesProvider: {
        getRuleSnippets: async () => [
          'Agents must clean temporary files after task completion; remove /tmp/prefix files.',
        ],
      },
      llm,
    });
    expect(r.pass).toBe(false);
    expect(r.code).toBe('RULE_CONFLICT');
    expect(r.salvageable).toBe(true);
  });

  it('edge: keyword 命中 + LLM 判定不冲突 → pass', async () => {
    const llm: LlmJudge = {
      async judgeConflict() {
        return { conflict: false };
      },
    };
    const c = makeCandidateObj(mkStrategy());
    const r = await reviewConflict(c, {
      config: DEFAULT_REVIEW_CONFIG,
      rulesProvider: {
        getRuleSnippets: async () => [
          'Agents must clean temporary files after task completion; remove /tmp/prefix files.',
        ],
      },
      llm,
    });
    expect(r.pass).toBe(true);
  });

  it('edge: 禁用 LLM，keyword 命中 → pass（仅告警）', async () => {
    const cfg: ReviewGateConfig = { ...DEFAULT_REVIEW_CONFIG, useLlmForConflict: false };
    const c = makeCandidateObj(mkStrategy());
    const r = await reviewConflict(c, {
      config: cfg,
      rulesProvider: {
        getRuleSnippets: async () => [
          'Agents must clean temporary files after task completion; remove /tmp/prefix files.',
        ],
      },
    });
    expect(r.pass).toBe(true);
    expect(r.detail?.note).toBe('keyword_match_without_llm_judge');
  });
});

// ===========================================================================
// Dimension: semantic
// ===========================================================================
describe('dimension: semantic', () => {
  it('happy-path: 质量良好、无重复', async () => {
    const c = makeCandidateObj(mkStrategy());
    const r = await reviewSemantic(c, { config: DEFAULT_REVIEW_CONFIG });
    expect(r.pass).toBe(true);
  });

  it('edge: recommended_action 太短 → LOW_QUALITY 可挽救', async () => {
    const s = mkStrategy({ recommended_action: 'fix' });
    const c = makeCandidateObj(s);
    const r = await reviewSemantic(c, { config: DEFAULT_REVIEW_CONFIG });
    expect(r.pass).toBe(false);
    expect(r.code).toBe('LOW_QUALITY');
    expect(r.salvageable).toBe(true);
  });

  it('edge: 相似度 ≥ 0.9 → DUPLICATE', async () => {
    const existing = mkStrategy({
      strategy_id: 'existing-1',
      recommended_action: 'clean /tmp/prefix-* files after task completion',
      trigger_conditions: 'temporary files remain after subagent task completes',
    });
    const candidate = makeCandidateObj(
      mkStrategy({
        // 几乎相同
        recommended_action: 'clean /tmp/prefix-* files after task completion',
        trigger_conditions: 'temporary files remain after subagent task completes',
      }),
    );
    const r = await reviewSemantic(candidate, {
      config: DEFAULT_REVIEW_CONFIG,
      strategyLookup: {
        listActiveStrategies: () => [existing],
      },
    });
    expect(r.pass).toBe(false);
    expect(r.code).toBe('DUPLICATE');
    expect(r.detail?.duplicateOf).toBe('existing-1');
    expect(Number(r.detail?.maxSimilarity)).toBeGreaterThanOrEqual(0.9);
  });

  it('edge: 不同主题相似度低 → 通过', async () => {
    const existing = mkStrategy({
      strategy_id: 'existing-2',
      recommended_action: 'deploy via docker compose with restart unless-stopped',
      trigger_conditions: 'service needs auto restart on crash',
    });
    const candidate = makeCandidateObj(mkStrategy());
    const r = await reviewSemantic(candidate, {
      config: DEFAULT_REVIEW_CONFIG,
      strategyLookup: { listActiveStrategies: () => [existing] },
    });
    expect(r.pass).toBe(true);
    expect(Number(r.detail?.maxSimilarity)).toBeLessThan(0.9);
  });
});

// ===========================================================================
// Orchestrator: ReviewGate
// ===========================================================================
describe('ReviewGate 编排', () => {
  it('全部通过 → pending→reviewing→validating，audit log 含 4 dimension + 1 summary', async () => {
    const s = mkStrategy();
    const inst = mkInstance(s.strategy_id);
    const c = persistCandidate(s, [inst]);

    const sink = new InMemoryAuditSink();
    const gate = new ReviewGate(store, {
      auditSink: sink,
      strategyLookup: strategyLookupFromCandidateStore(store),
    });

    const result = await gate.review(c);
    expect(result.pass).toBe(true);
    expect(result.final_state).toBe('validating');
    expect(result.dimensions).toHaveLength(4);
    expect(result.dimensions.map((d) => d.dimension)).toEqual([
      'metadata',
      'safety',
      'conflict',
      'semantic',
    ]);

    // Store 状态
    const reloaded = store.get(c.candidate_id)!;
    expect(reloaded.state).toBe('validating');

    // 转移历史
    const trans = store.getTransitions(c.candidate_id);
    expect(trans.map((t) => t.to_state)).toEqual(['pending', 'reviewing', 'validating']);
    expect(trans[1].action).toBe('start_review');
    expect(trans[2].action).toBe('review_passed');

    // Audit log：4 dim + 1 summary
    expect(sink.entries).toHaveLength(5);
    expect(sink.entries[4].kind).toBe('summary');
    expect(sink.entries[4].pass).toBe(true);
  });

  it('metadata 失败 → 短路，safety/conflict/semantic 不执行', async () => {
    const s = mkStrategy({ recommended_action: '' });
    const c = persistCandidate(s);
    const sink = new InMemoryAuditSink();
    const gate = new ReviewGate(store, { auditSink: sink });

    const result = await gate.review(c);
    expect(result.pass).toBe(false);
    expect(result.failed_at).toBe('metadata');
    expect(result.dimensions).toHaveLength(1); // 短路
    expect(result.final_state).toBe('rejected');

    const reloaded = store.get(c.candidate_id)!;
    expect(reloaded.state).toBe('rejected');

    const trans = store.getTransitions(c.candidate_id);
    expect(trans[trans.length - 1].action).toBe('review_failed');
    expect(trans[trans.length - 1].to_state).toBe('rejected');

    // audit: 1 dim + 1 summary
    expect(sink.entries).toHaveLength(2);
    expect(sink.entries[0].kind).toBe('dimension');
    expect(sink.entries[0].dimension).toBe('metadata');
    expect(sink.entries[1].kind).toBe('summary');
  });

  it('safety 失败 → 仅 metadata+safety 执行', async () => {
    const s = mkStrategy({ recommended_action: 'please run rm -rf / to clean filesystem' });
    const c = persistCandidate(s);
    const sink = new InMemoryAuditSink();
    const gate = new ReviewGate(store, { auditSink: sink });

    const result = await gate.review(c);
    expect(result.pass).toBe(false);
    expect(result.failed_at).toBe('safety');
    expect(result.dimensions).toHaveLength(2);
    expect(result.dimensions[0].dimension).toBe('metadata');
    expect(result.dimensions[0].pass).toBe(true);
    expect(result.dimensions[1].dimension).toBe('safety');
    expect(result.dimensions[1].pass).toBe(false);
    expect(result.final_state).toBe('rejected');
    expect(store.get(c.candidate_id)!.state).toBe('rejected');
  });

  it('semantic 失败（duplicate）→ rejected 可挽救', async () => {
    // 先存一条既有 Strategy，处于 validating
    const existing = mkStrategy({
      problem_category: 'cleanup_existing',
      recommended_action: 'clean /tmp/prefix-* files after task completion',
      trigger_conditions: 'temporary files remain after subagent task completes',
    });
    const existingCand = store.create({ strategy: existing, initialState: 'pending' });
    store.transition(existingCand.candidate_id, 'pending', 'reviewing', 'start_review');
    store.transition(existingCand.candidate_id, 'reviewing', 'validating', 'review_passed');

    // 新候选几乎相同的 action+trigger，不同 strategy_id
    const dup = mkStrategy({
      problem_category: 'cleanup_new',
      recommended_action: 'clean /tmp/prefix-* files after task completion',
      trigger_conditions: 'temporary files remain after subagent task completes',
    });
    const c = persistCandidate(dup);

    const gate = new ReviewGate(store, {
      strategyLookup: strategyLookupFromCandidateStore(store),
    });
    const result = await gate.review(c);
    expect(result.pass).toBe(false);
    expect(result.failed_at).toBe('semantic');
    expect(result.dimensions[3].code).toBe('DUPLICATE');
    expect(result.dimensions[3].salvageable).toBe(true);
    expect(store.get(c.candidate_id)!.state).toBe('rejected');
  });

  it('reviewer 标识写入 audit log', async () => {
    const c = persistCandidate(mkStrategy(), [mkInstance(mkStrategy().strategy_id)]);
    const sink = new InMemoryAuditSink();
    const gate = new ReviewGate(store, {
      auditSink: sink,
      reviewer: 'test-reviewer-42',
      strategyLookup: strategyLookupFromCandidateStore(store),
    });
    const result = await gate.review(c);
    expect(result.reviewed_by).toBe('test-reviewer-42');
    for (const e of sink.entries) {
      expect(e.reviewer).toBe('test-reviewer-42');
    }
  });

  it('非 pending / reviewing 状态 → 抛错', async () => {
    const c = persistCandidate(mkStrategy());
    // 直接转到 validating
    store.transition(c.candidate_id, 'pending', 'reviewing', 'start_review');
    store.transition(c.candidate_id, 'reviewing', 'validating', 'review_passed');

    const reloaded = store.get(c.candidate_id)!;
    const gate = new ReviewGate(store);
    await expect(gate.review(reloaded)).rejects.toThrow(/state is 'validating'/);
  });

  it('LLM 抛异常 → 维度失败但不崩溃，转 rejected', async () => {
    const badLlm: LlmJudge = {
      async judgeConflict() {
        throw new Error('LLM timeout');
      },
    };
    const c = persistCandidate(mkStrategy());
    const gate = new ReviewGate(store, {
      llm: badLlm,
      rulesProvider: {
        getRuleSnippets: async () => [
          'Agents must clean temporary files after task completion',
        ],
      },
    });
    const result = await gate.review(c);
    expect(result.pass).toBe(false);
    expect(result.failed_at).toBe('conflict');
    expect(result.dimensions[2].code).toBe('REVIEW_EXCEPTION');
    expect(store.get(c.candidate_id)!.state).toBe('rejected');
  });
});
