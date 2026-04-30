// src/orchestrator/graduate.spec.ts
//
// T-058a · graduate.ts — focused unit tests.
//
// Scope:
//   - renderGraduatedBody pure-function output shape (heading / sections / tags)
//   - graduateCandidate scope guard: rejects non-`general` scope (P1a constraint)
//
// Note: full graduateCandidate executor wiring (marker block writes, audit YAML)
// is integration-tested via cycle.spec.ts > "PASS verdict → graduated" because
// it requires GraduationExecutor + filesystem fixtures already established there.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GraduationExecutor } from '../graduation/executor.js';
import { computeStrategyId, computeInstanceId } from '../kernel/content-id.js';
import type {
  Candidate,
  EnvFingerprint,
  EvaluatorOutput,
  Strategy,
  Instance,
} from '../kernel/types.js';

import { renderGraduatedBody, graduateCandidate } from './graduate.js';

const ENV: EnvFingerprint = {
  runtime: 'openclaw',
  platform: 'linux',
  arch: 'x64',
  model: 'claude-opus-4.7',
};

function mkStrategy(overrides: Partial<Strategy> = {}): Strategy {
  const base = {
    problem_category: 'file_cleanup',
    trigger_conditions: 'temporary files remain in /tmp after task completes',
    recommended_action: 'rm -f /tmp/prefix-*',
  };
  const id = computeStrategyId(base);
  return {
    strategy_id: id,
    problem_category: base.problem_category,
    trigger_conditions: base.trigger_conditions,
    recommended_action: base.recommended_action,
    scope: 'general',
    tags: ['cleanup', 'tmpfs'],
    summary: 'clean up tmp leftovers after run',
    created_at: new Date().toISOString(),
    instance_ids: [],
    ...overrides,
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
      { type: 'command_exit_code', command: 'test ! -f /tmp/x', expected_exit_code: 0 },
    ],
    trial_results: [],
    created_at: new Date().toISOString(),
  };
}

function mkCandidate(strategy: Strategy): Candidate {
  return {
    candidate_id: strategy.strategy_id,
    state: 'validating',
    strategy,
    instances: [mkInstance(strategy.strategy_id)],
    created_at: new Date().toISOString(),
    transitions: [],
  };
}

function mkEvalResult(): EvaluatorOutput {
  return {
    candidate_id: 'sha256:dummy',
    verdict: 'PASS',
    next_state: 'graduated',
    confidence: 0.65,
    rationale: 'row1_L1pass_L2pass_L3pass',
    layers: [
      { layer: 'L1', status: 'pass', rationale: 'pass=10/10' },
      { layer: 'L2', status: 'pass', rationale: 'baseline mean diff > 0', confidence: 0.6 },
      { layer: 'L3', status: 'pass', rationale: 'judge=pass', confidence: 0.9 },
      { layer: 'L4', status: 'skipped', rationale: 'P1a' },
    ],
    l1_aggregate: {
      status: 'pass',
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      passRate: 1,
      hasCommandAssertion: true,
    },
    l2_result: {
      status: 'pass',
      pValue: 0.01,
      cohensD: 1.2,
      baselineMean: 0.55,
      trialMean: 0.95,
      deltaMean: 0.4,
      relDelta: 0.7,
      sampleWeight: 1,
      rationale: 'pass',
    } as any,
    secure_l1_required_triggered: false,
  } as any;
}

// ---------------------------------------------------------------------------
// renderGraduatedBody — pure function
// ---------------------------------------------------------------------------

describe('renderGraduatedBody', () => {
  it('emits heading + summary + trigger + action + tags', () => {
    const body = renderGraduatedBody(mkCandidate(mkStrategy()));
    expect(body).toContain('### file_cleanup');
    expect(body).toContain('clean up tmp leftovers after run');
    expect(body).toContain('**触发条件：** temporary files remain in /tmp after task completes');
    expect(body).toContain('**推荐动作：** rm -f /tmp/prefix-*');
    expect(body).toContain('**标签：** `cleanup` `tmpfs`');
    expect(body.endsWith('\n')).toBe(true);
  });

  it('omits summary block when strategy.summary is absent', () => {
    const s = mkStrategy({ summary: undefined });
    const body = renderGraduatedBody(mkCandidate(s));
    expect(body).toContain('### file_cleanup');
    expect(body).toContain('**触发条件：**');
    // No summary line between heading and 触发条件
    const heading = body.indexOf('### file_cleanup');
    const trigger = body.indexOf('**触发条件：**');
    const between = body.slice(heading, trigger);
    expect(between.split('\n').filter((l) => l.trim().length > 0)).toEqual([
      '### file_cleanup',
    ]);
  });

  it('omits tags block when tags is empty', () => {
    const s = mkStrategy({ tags: [] });
    const body = renderGraduatedBody(mkCandidate(s));
    expect(body).not.toContain('**标签：**');
  });
});

// ---------------------------------------------------------------------------
// graduateCandidate — scope guard
// ---------------------------------------------------------------------------

describe('graduateCandidate :: scope guard (P1a constraint)', () => {
  let tmpDir: string;
  let workspaceDir: string;
  let executor: GraduationExecutor;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'grad-test-'));
    workspaceDir = join(tmpDir, 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    executor = new GraduationExecutor({
      workspaceDir,
      auditDir: join(tmpDir, 'audit'),
      graduatedDir: join(tmpDir, 'graduated'),
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects non-`general` scope by throwing GraduationScopeError', () => {
    // Override scope post-hoc so we don't have to fight the schema; the
    // executor is the source of truth and it rejects any scope !== 'general'.
    const strategy = mkStrategy();
    (strategy as any).scope = 'project';
    const candidate = mkCandidate(strategy);

    expect(() =>
      graduateCandidate({
        candidate,
        evalResult: mkEvalResult(),
        trialCount: 10,
        executor,
      }),
    ).toThrowError(/scope/i);
  });

  it('throws when neither executor nor executorOptions is provided', () => {
    const candidate = mkCandidate(mkStrategy());
    expect(() =>
      graduateCandidate({
        candidate,
        evalResult: mkEvalResult(),
        trialCount: 10,
      }),
    ).toThrowError(/executor/);
  });
});
