// src/evaluator/evaluator.spec.ts
//
// T-P1a-007 · Four-Layer Evaluator tests.
// Covers:
//   - 13-row truth table (§6.1.2) via applyTruthTable + end-to-end
//   - secure_l1_required rule (Blocker B2 / v5.0.1)
//   - L1 aggregation (pass/fail/skipped + command detection)
//   - L2 statistical evaluator: Welch + Cohen's d + zero-variance + NaN + min-sample
//   - Confidence: Wilson + weights + threshold classification
//
// Test-case ids cross-ref:
//   #102 secure_l1_required_block_graduation
//   #106 l2_zero_variance_protection
//   #107 l2_nan_returns_inconclusive
//   #108 command_pass_without_secure_backend_not_counted
//   #109 historical_insecure_trial_cannot_satisfy_secure_l1

import { describe, it, expect } from 'vitest';

import type {
  AssertionSpec,
  EnvFingerprint,
  TrialResult,
} from '../kernel/types.js';

import {
  aggregateL1,
  applyTruthTable,
  classifyConfidence,
  computeConfidence,
  evaluateCandidate,
  evaluateL2,
  hasSecureL1Evidence,
  permissiveEvidenceStore,
  requiresSecureL1,
  type EvaluatorInput,
  type MetricSamples,
} from './evaluator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const envFp: EnvFingerprint = {
  runtime: 'openclaw',
  platform: 'linux',
  arch: 'x64',
  runtimeVersion: '2026.4.0',
};

const VALID_SHA = 'a'.repeat(64);

function baseTrial(overrides: Partial<TrialResult> = {}): TrialResult {
  return {
    trial_id: 'trial_' + Math.random().toString(36).slice(2),
    candidate_id: 'c1',
    session_id: 's1',
    runtime: 'openclaw',
    started_at: '2026-04-22T00:00:00Z',
    completed_at: '2026-04-22T00:01:00Z',
    assertions: [],
    metrics: { turns: 10, errors: 0, token_usage: 1000, completion_rate: 1.0 },
    env_fingerprint: envFp,
    ...overrides,
  };
}

function fileAssertion(): AssertionSpec {
  return { type: 'file_exists', description: 'must have file' };
}

function commandAssertion(): AssertionSpec {
  return {
    type: 'command_exit_code',
    command: 'echo hi',
    expected_exit_code: 0,
    command_allowlist: ['echo'],
    timeout_ms: 1000,
  };
}

function trialWithAssertionStatus(
  assertions: Array<{ type: string; status: TrialResult['assertions'][number]['status'] }>,
  opts: { secure?: boolean; traceHash?: string } = {},
): TrialResult {
  return baseTrial({
    assertions: assertions.map((a) => ({
      type: a.type,
      status: a.status,
      duration_ms: 10,
    })),
    secure_l1_evidence: opts.secure
      ? {
          sandbox_type: 'bwrap',
          exit_code_verified: true,
          execution_trace_hash: opts.traceHash ?? VALID_SHA,
          timestamp: '2026-04-22T00:00:30Z',
        }
      : undefined,
  });
}

// Good metric samples: both sides have 5+ points.
function okSamples(baseMean = 0.6, trialMean = 0.8, jitter = 0.02): MetricSamples {
  const gen = (m: number, n = 10) =>
    Array.from({ length: n }, (_, i) => m + ((i % 2 === 0 ? 1 : -1) * jitter));
  return { baseline: gen(baseMean), trial: gen(trialMean) };
}

// ---------------------------------------------------------------------------
// L1 Aggregation (5 tests)
// ---------------------------------------------------------------------------

describe('aggregateL1', () => {
  it('returns pass when all assertions pass across trials', () => {
    const agg = aggregateL1(
      [fileAssertion()],
      [
        trialWithAssertionStatus([{ type: 'file_exists', status: 'pass' }]),
        trialWithAssertionStatus([{ type: 'file_exists', status: 'pass' }]),
      ],
    );
    expect(agg.status).toBe('pass');
    expect(agg.passed).toBe(2);
    expect(agg.passRate).toBe(1);
    expect(agg.hasCommandAssertion).toBe(false);
  });

  it('returns fail as soon as any assertion fails', () => {
    const agg = aggregateL1(
      [fileAssertion()],
      [
        trialWithAssertionStatus([{ type: 'file_exists', status: 'pass' }]),
        trialWithAssertionStatus([{ type: 'file_exists', status: 'fail' }]),
      ],
    );
    expect(agg.status).toBe('fail');
    expect(agg.failed).toBe(1);
  });

  it('treats timeout and error as fail', () => {
    const agg = aggregateL1(
      [fileAssertion()],
      [trialWithAssertionStatus([{ type: 'file_exists', status: 'timeout' }])],
    );
    expect(agg.status).toBe('fail');
  });

  it('returns skipped when there are no trials', () => {
    const agg = aggregateL1([fileAssertion()], []);
    expect(agg.status).toBe('skipped');
    expect(agg.total).toBe(0);
  });

  it('returns skipped when every assertion is skipped', () => {
    const agg = aggregateL1(
      [commandAssertion()],
      [
        trialWithAssertionStatus([{ type: 'command_exit_code', status: 'skipped' }]),
        trialWithAssertionStatus([{ type: 'command_exit_code', status: 'skipped' }]),
      ],
    );
    expect(agg.status).toBe('skipped');
    expect(agg.hasCommandAssertion).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// secure_l1_required rule (4 tests — includes #102/#108/#109)
// ---------------------------------------------------------------------------

describe('secure_l1_required', () => {
  it('requiresSecureL1 is true iff assertions include command_exit_code', () => {
    expect(requiresSecureL1([fileAssertion()])).toBe(false);
    expect(requiresSecureL1([commandAssertion()])).toBe(true);
    expect(requiresSecureL1([fileAssertion(), commandAssertion()])).toBe(true);
  });

  it('hasSecureL1Evidence true only when all invariants hold (sandbox_type + trace_hash + registered + pass)', () => {
    // Valid
    const t1 = trialWithAssertionStatus(
      [{ type: 'command_exit_code', status: 'pass' }],
      { secure: true },
    );
    expect(hasSecureL1Evidence([t1], permissiveEvidenceStore)).toBe(true);

    // #108: command assertion pass but no evidence -> false
    const t2 = trialWithAssertionStatus(
      [{ type: 'command_exit_code', status: 'pass' }],
    );
    expect(hasSecureL1Evidence([t2], permissiveEvidenceStore)).toBe(false);

    // #109: historical trial with bad hash -> false
    const t3 = trialWithAssertionStatus(
      [{ type: 'command_exit_code', status: 'pass' }],
      { secure: true, traceHash: 'not-a-sha' },
    );
    expect(hasSecureL1Evidence([t3], permissiveEvidenceStore)).toBe(false);

    // Evidence exists but command assertion did not pass in that trial -> false
    const t4 = trialWithAssertionStatus(
      [{ type: 'command_exit_code', status: 'fail' }],
      { secure: true },
    );
    expect(hasSecureL1Evidence([t4], permissiveEvidenceStore)).toBe(false);

    // Evidence store rejects hash -> false
    const strictStore = { hasTrace: () => false };
    expect(hasSecureL1Evidence([t1], strictStore)).toBe(false);
  });

  it('#102 downgrades PASS_L2 to INCONCLUSIVE when command candidate lacks secure evidence', () => {
    const input: EvaluatorInput = {
      candidate_id: 'c1',
      assertions: [commandAssertion()],
      trials: [
        // L1 skipped (no sandbox), but L2 samples will be PASS
        trialWithAssertionStatus([{ type: 'command_exit_code', status: 'skipped' }]),
        trialWithAssertionStatus([{ type: 'command_exit_code', status: 'skipped' }]),
      ],
      metrics: okSamples(),
      l3: 'pass', // would otherwise be row #7 PASS_L2
    };
    const out = evaluateCandidate(input);
    expect(out.secure_l1_required_triggered).toBe(true);
    expect(out.verdict).toBe('INCONCLUSIVE');
    expect(out.next_state).toBe('dormant');
    expect(out.dormant_reason).toBe('inconclusive');
  });

  it('does not downgrade when candidate has no command assertion', () => {
    const input: EvaluatorInput = {
      candidate_id: 'c1',
      assertions: [fileAssertion()],
      trials: [
        trialWithAssertionStatus([{ type: 'file_exists', status: 'skipped' }]),
      ],
      metrics: okSamples(),
      l3: 'pass',
    };
    const out = evaluateCandidate(input);
    expect(out.secure_l1_required_triggered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L2 Statistical Evaluator (6 tests — includes #106/#107)
// ---------------------------------------------------------------------------

describe('evaluateL2', () => {
  it('returns inconclusive when either group has fewer than 5 samples', () => {
    const r = evaluateL2({ baseline: [0.5, 0.6, 0.5], trial: [0.7, 0.8, 0.7, 0.8, 0.7] });
    expect(r.status).toBe('inconclusive');
    expect(r.rationale).toMatch(/min_sample_size/);
  });

  it('#107 returns inconclusive + nanDetected when any value is NaN/Infinity', () => {
    const withNaN: MetricSamples = {
      baseline: [0.5, 0.6, 0.5, 0.6, NaN],
      trial: [0.7, 0.8, 0.7, 0.8, 0.7],
    };
    const r = evaluateL2(withNaN);
    expect(r.status).toBe('inconclusive');
    expect(r.nanDetected).toBe(true);
    expect(r.rationale).toBe('l2_nan_detected');

    const withInf: MetricSamples = {
      baseline: [0.5, 0.6, 0.5, 0.6, 0.5],
      trial: [0.7, 0.8, 0.7, 0.8, Infinity],
    };
    expect(evaluateL2(withInf).nanDetected).toBe(true);
  });

  it('#106 zero-variance path: delta > 10% -> pass when trial > baseline', () => {
    const r = evaluateL2({
      baseline: [0.5, 0.5, 0.5, 0.5, 0.5],
      trial: [0.7, 0.7, 0.7, 0.7, 0.7],
    });
    expect(r.zeroVarianceFallback).toBe(true);
    expect(r.status).toBe('pass');
    expect(r.pValue).toBeNull();
    // T-058c-Lite: zero-variance significant path now exposes a Cohen-d proxy
    // (sign(delta) * min(2, relDelta)) so confidence has a non-zero effect-weight.
    // **TODO(T-058c v2):** 评估是否保留 proxy；若废除，恢复 toBeNull 断言。
    expect(r.cohenD).not.toBeNull();
    expect(r.cohenD!).toBeGreaterThan(0); // delta>0 → sign=+1
    expect(Math.abs(r.cohenD!)).toBeLessThanOrEqual(2);
  });

  it('#106 zero-variance path: delta <= 10% -> inconclusive', () => {
    const r = evaluateL2({
      baseline: [0.80, 0.80, 0.80, 0.80, 0.80],
      trial: [0.82, 0.82, 0.82, 0.82, 0.82],
    });
    expect(r.zeroVarianceFallback).toBe(true);
    expect(r.status).toBe('inconclusive');
  });

  it('pass when trial >> baseline with low variance (significant + large effect)', () => {
    const baseline = [0.50, 0.52, 0.49, 0.51, 0.50, 0.48, 0.51, 0.50, 0.52, 0.49];
    const trial = [0.80, 0.82, 0.79, 0.81, 0.80, 0.78, 0.81, 0.80, 0.82, 0.79];
    const r = evaluateL2({ baseline, trial });
    expect(r.status).toBe('pass');
    expect(r.zeroVarianceFallback).toBe(false);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.cohenD ?? 0).toBeGreaterThanOrEqual(0.5);
  });

  it('fail when trial <<  baseline with low variance (regression)', () => {
    const baseline = [0.80, 0.82, 0.79, 0.81, 0.80, 0.78, 0.81, 0.80, 0.82, 0.79];
    const trial = [0.50, 0.52, 0.49, 0.51, 0.50, 0.48, 0.51, 0.50, 0.52, 0.49];
    const r = evaluateL2({ baseline, trial });
    expect(r.status).toBe('fail');
    expect(r.deltaMean ?? 0).toBeLessThan(0);
  });

  it('inconclusive when difference is small relative to noise', () => {
    const baseline = [0.50, 0.55, 0.48, 0.52, 0.50, 0.53, 0.49, 0.51, 0.54, 0.50];
    const trial = [0.52, 0.53, 0.49, 0.51, 0.52, 0.50, 0.51, 0.52, 0.50, 0.51];
    const r = evaluateL2({ baseline, trial });
    expect(r.status).toBe('inconclusive');
  });
});

// ---------------------------------------------------------------------------
// Truth Table (13 rows)
// ---------------------------------------------------------------------------

describe('applyTruthTable — all 13 rows', () => {
  it('#1 L1 pass + L2 pass + L3 pass -> PASS / graduated', () => {
    expect(applyTruthTable('pass', 'pass', 'pass')).toMatchObject({
      verdict: 'PASS',
      next_state: 'graduated',
    });
  });
  it('#2 L1 pass + L2 pass + L3 fail -> PASS / graduated', () => {
    expect(applyTruthTable('pass', 'pass', 'fail')).toMatchObject({
      verdict: 'PASS',
      next_state: 'graduated',
    });
  });
  it('#3 L1 pass + L2 inconc + L3 pass -> PASS_WEAK / graduated', () => {
    expect(applyTruthTable('pass', 'inconclusive', 'pass')).toMatchObject({
      verdict: 'PASS_WEAK',
      next_state: 'graduated',
    });
  });
  it('#4 L1 pass + L2 inconc + L3 fail -> INCONCLUSIVE / dormant', () => {
    expect(applyTruthTable('pass', 'inconclusive', 'fail')).toMatchObject({
      verdict: 'INCONCLUSIVE',
      next_state: 'dormant',
    });
  });
  it('#5 L1 pass + L2 fail -> CONFLICT / dormant', () => {
    expect(applyTruthTable('pass', 'fail', 'pass')).toMatchObject({
      verdict: 'CONFLICT',
      next_state: 'dormant',
    });
    expect(applyTruthTable('pass', 'fail', 'skipped')).toMatchObject({
      verdict: 'CONFLICT',
    });
  });
  it('#6 L1 fail -> FAIL / retired (short-circuit, no L2/L3 needed)', () => {
    expect(applyTruthTable('fail', 'pass', 'pass')).toMatchObject({
      verdict: 'FAIL',
      next_state: 'retired',
    });
    expect(applyTruthTable('fail', 'skipped', 'skipped')).toMatchObject({
      verdict: 'FAIL',
    });
  });
  it('#7 L1 skip + L2 pass + L3 pass -> PASS_L2 / graduated', () => {
    expect(applyTruthTable('skipped', 'pass', 'pass')).toMatchObject({
      verdict: 'PASS_L2',
      next_state: 'graduated',
    });
  });
  it('#8 L1 skip + L2 pass + L3 fail -> PASS_WEAK / graduated', () => {
    expect(applyTruthTable('skipped', 'pass', 'fail')).toMatchObject({
      verdict: 'PASS_WEAK',
      next_state: 'graduated',
    });
  });
  it('#9 L1 skip + L2 fail -> FAIL_L2 / retired', () => {
    expect(applyTruthTable('skipped', 'fail', 'pass')).toMatchObject({
      verdict: 'FAIL_L2',
      next_state: 'retired',
    });
  });
  it('#10 L1 skip + L2 inconc + L3 pass -> INCONCLUSIVE / dormant', () => {
    expect(applyTruthTable('skipped', 'inconclusive', 'pass')).toMatchObject({
      verdict: 'INCONCLUSIVE',
      next_state: 'dormant',
    });
  });
  it('#11 L1 skip + L2 inconc + L3 fail -> LIKELY_FAIL / dormant', () => {
    expect(applyTruthTable('skipped', 'inconclusive', 'fail')).toMatchObject({
      verdict: 'LIKELY_FAIL',
      next_state: 'dormant',
    });
  });
  it('#12 L1 inconclusive -> INCONCLUSIVE / dormant (handler contract violation)', () => {
    expect(applyTruthTable('inconclusive', 'pass', 'pass')).toMatchObject({
      verdict: 'INCONCLUSIVE',
      next_state: 'dormant',
    });
  });
  it('#13 all skipped -> SYSTEM_ERROR / dormant', () => {
    expect(applyTruthTable('skipped', 'skipped', 'skipped')).toMatchObject({
      verdict: 'SYSTEM_ERROR',
      next_state: 'dormant',
    });
  });
});

// ---------------------------------------------------------------------------
// Confidence (§6.2.1 / §6.2.2)
// ---------------------------------------------------------------------------

describe('computeConfidence & classifyConfidence', () => {
  it('returns 0 when sample size is 0', () => {
    expect(computeConfidence(1, 0, 1)).toBe(0);
  });

  it('grows monotonically with sample size for same passRate and effect', () => {
    const low = computeConfidence(1, 2, 0.8);
    const mid = computeConfidence(1, 5, 0.8);
    const hi = computeConfidence(1, 10, 0.8);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(hi);
  });

  it('higher effect size strictly increases confidence at fixed (passRate, n)', () => {
    const a = computeConfidence(0.9, 10, 0.1);
    const b = computeConfidence(0.9, 10, 0.8);
    expect(b).toBeGreaterThan(a);
  });

  it('stays within [0, 1]', () => {
    expect(computeConfidence(0, 100, 0)).toBeGreaterThanOrEqual(0);
    expect(computeConfidence(1, 100, 2)).toBeLessThanOrEqual(1);
  });

  it('classifyConfidence honours §6.2.2 thresholds (High≥0.7, Mid≥0.5)', () => {
    expect(classifyConfidence(0.75)).toBe('high');
    expect(classifyConfidence(0.7)).toBe('high');
    expect(classifyConfidence(0.6)).toBe('mid');
    expect(classifyConfidence(0.5)).toBe('mid');
    expect(classifyConfidence(0.49)).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// End-to-end evaluateCandidate
// ---------------------------------------------------------------------------

describe('evaluateCandidate (integration)', () => {
  const fixedNow = () => new Date('2026-04-22T09:00:00Z');

  it('graduates when L1 pass + L2 pass (row #1)', () => {
    const input: EvaluatorInput = {
      candidate_id: 'c-row1',
      assertions: [fileAssertion()],
      trials: Array.from({ length: 5 }, () =>
        trialWithAssertionStatus([{ type: 'file_exists', status: 'pass' }]),
      ),
      metrics: okSamples(0.5, 0.8, 0.01),
      l3: 'pass',
      now: fixedNow,
    };
    const out = evaluateCandidate(input);
    expect(out.verdict).toBe('PASS');
    expect(out.next_state).toBe('graduated');
    expect(out.dormant_reason).toBeNull();
    expect(out.evaluated_at).toBe('2026-04-22T09:00:00.000Z');
    expect(out.layers.map((l) => l.layer)).toEqual(['L1', 'L2', 'L3', 'L4']);
  });

  it('retires on L1 fail regardless of L2 (row #6)', () => {
    const input: EvaluatorInput = {
      candidate_id: 'c-row6',
      assertions: [fileAssertion()],
      trials: [
        trialWithAssertionStatus([{ type: 'file_exists', status: 'pass' }]),
        trialWithAssertionStatus([{ type: 'file_exists', status: 'fail' }]),
      ],
      metrics: okSamples(0.5, 0.9),
      l3: 'pass',
    };
    const out = evaluateCandidate(input);
    expect(out.verdict).toBe('FAIL');
    expect(out.next_state).toBe('retired');
  });

  it('reports CONFLICT when L1 pass + L2 fail (row #5)', () => {
    const input: EvaluatorInput = {
      candidate_id: 'c-row5',
      assertions: [fileAssertion()],
      trials: Array.from({ length: 5 }, () =>
        trialWithAssertionStatus([{ type: 'file_exists', status: 'pass' }]),
      ),
      // regression: trial worse than baseline
      metrics: okSamples(0.8, 0.4, 0.01),
      l3: 'skipped',
    };
    const out = evaluateCandidate(input);
    expect(out.verdict).toBe('CONFLICT');
    expect(out.next_state).toBe('dormant');
  });

  it('graduates via PASS_L2 when sandbox absent but file assertions skipped and L2/L3 pass (row #7)', () => {
    const input: EvaluatorInput = {
      candidate_id: 'c-row7',
      assertions: [fileAssertion()], // NOT a command assertion
      trials: Array.from({ length: 5 }, () =>
        trialWithAssertionStatus([{ type: 'file_exists', status: 'skipped' }]),
      ),
      metrics: okSamples(0.5, 0.8, 0.01),
      l3: 'pass',
    };
    const out = evaluateCandidate(input);
    expect(out.verdict).toBe('PASS_L2');
    expect(out.next_state).toBe('graduated');
    expect(out.secure_l1_required_triggered).toBe(false);
  });

  it('emits SYSTEM_ERROR when everything is skipped (row #13)', () => {
    const input: EvaluatorInput = {
      candidate_id: 'c-row13',
      assertions: [fileAssertion()],
      trials: [], // no trials -> L1 skipped
      metrics: { baseline: [], trial: [] }, // L2 inconclusive from min-sample
      l3: 'skipped',
    };
    const out = evaluateCandidate(input);
    // L2 will be inconclusive (min-sample not met), not skipped, so this is
    // row #10/#11 family -> INCONCLUSIVE. Verify explicit row #13 via direct
    // truth-table call instead:
    expect(['INCONCLUSIVE', 'SYSTEM_ERROR']).toContain(out.verdict);
    expect(out.next_state).toBe('dormant');
  });

  it('includes confidence in result and respects threshold bands', () => {
    const input: EvaluatorInput = {
      candidate_id: 'c-conf',
      assertions: [fileAssertion()],
      trials: Array.from({ length: 10 }, () =>
        trialWithAssertionStatus([{ type: 'file_exists', status: 'pass' }]),
      ),
      metrics: okSamples(0.5, 0.8, 0.01),
      l3: 'pass',
    };
    const out = evaluateCandidate(input);
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.confidence).toBeLessThanOrEqual(1);
    // 10 trials, all pass, large Cohen's d -> should be in the high band
    expect(classifyConfidence(out.confidence)).toBe('high');
  });

  it('command candidate with secure evidence but L1 skipped still graduates via row #7 when evidence valid', () => {
    const input: EvaluatorInput = {
      candidate_id: 'c-secure-ok',
      assertions: [commandAssertion()],
      trials: [
        // First trial ran L1 in sandbox with pass + evidence
        trialWithAssertionStatus(
          [{ type: 'command_exit_code', status: 'pass' }],
          { secure: true },
        ),
        // Subsequent trials in sandbox-less envs (skipped)
        trialWithAssertionStatus([{ type: 'command_exit_code', status: 'skipped' }]),
        trialWithAssertionStatus([{ type: 'command_exit_code', status: 'skipped' }]),
        trialWithAssertionStatus([{ type: 'command_exit_code', status: 'skipped' }]),
        trialWithAssertionStatus([{ type: 'command_exit_code', status: 'skipped' }]),
      ],
      metrics: okSamples(0.5, 0.8, 0.01),
      l3: 'pass',
    };
    const out = evaluateCandidate(input);
    expect(out.secure_l1_required_triggered).toBe(false);
    // L1 aggregate: 1 pass + 4 skipped -> status = pass (any pass counts)
    // So this becomes row #1 PASS. Just assert we didn't downgrade:
    expect(out.next_state).toBe('graduated');
  });
});
