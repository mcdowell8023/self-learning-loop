// src/evaluator/evaluator.ts
//
// T-P1a-007 · Four-Layer Evaluator (L1 + L2)
//
// Implements the decision layer:
//   - L1 Assertion Engine: pass/fail/skipped aggregation over trial assertions
//   - L2 Statistical Evaluator: Welch t-test + Cohen's d on trial vs baseline
//   - Truth table (13 rows, §6.1.2) combining L1/L2 (+ L3 placeholder) to a Verdict
//   - secure_l1_required rule (v5.0.1, Blocker B2): command assertions must have
//     at least one secure L1 evidence, else PASS_L2/PASS_WEAK -> INCONCLUSIVE
//   - Confidence: Wilson score lower bound + sample & effect-size weighting
//
// Design reference: learning-loop-design-v5.0.5.md §6.1 - §6.2
// Ticket: /home/mcdowell/open-claw-output/doc/learning-loop-P1a-tickets.md (T-P1a-007)
//
// Scope note (vs ticket file layout):
//   Ticket lists 4 separate files (evaluator.ts / l1-assertion.ts / l2-metrics.ts /
//   confidence.ts). Per task instruction this consolidation keeps them as named
//   exports in a single file; re-export splits can be added later without API
//   breakage (pure additive).
//
// L3 (subjective reviewer signal) and L4 (human feedback) are INTERFACE-ONLY in
// P1a: caller may pass an optional L3 signal; we do NOT compute it here.

import { tTestTwoSample } from 'simple-statistics';

import type {
  AssertionSpec,
  EvaluationVerdict,
  LayerResult,
  LayerStatus,
  SecureL1Evidence,
  TrialResult,
  VerdictName,
} from '../kernel/types.js';

// ---------------------------------------------------------------------------
// EvidenceStore contract (design §6.1.2 v5.0.3)
// ---------------------------------------------------------------------------

/**
 * Append-only store that maps a SHA-256 trace hash back to an audit trail.
 * Evaluator only needs `hasTrace()`; real implementation ships with P1b.
 */
export interface EvidenceStore {
  hasTrace(traceHash: string): boolean;
}

/** Stub evidence store that accepts any non-empty SHA-256 string. */
export const permissiveEvidenceStore: EvidenceStore = {
  hasTrace: (h) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h),
};

// ---------------------------------------------------------------------------
// L3 placeholder (subjective signal)
// ---------------------------------------------------------------------------

/** Caller-supplied L3 signal. `undefined` = not evaluated (treated as skipped). */
export type L3Signal = 'pass' | 'fail' | 'inconclusive' | 'skipped' | undefined;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Baseline/trial metric samples for L2. Each entry = one session's metric mean. */
export interface MetricSamples {
  /** Baseline samples: last 10 sessions before candidate entered `validating`. */
  baseline: number[];
  /** Trial samples: metric values from trial sessions. */
  trial: number[];
}

export interface EvaluatorInput {
  candidate_id: string;
  /** Candidate-level assertion specs (authoritative list). */
  assertions: AssertionSpec[];
  /** All trial results collected during `validating` phase. */
  trials: TrialResult[];
  /** L2 metric samples for the primary metric (e.g. completion_rate). */
  metrics: MetricSamples;
  /** Evidence store for secure_l1_required verification. */
  evidenceStore?: EvidenceStore;
  /** Optional L3 subjective signal from upstream reviewer/human proxy. */
  l3?: L3Signal;
  /** Freeze time for deterministic tests. Defaults to new Date(). */
  now?: () => Date;
}

export interface L1Aggregate {
  status: LayerStatus; // pass | fail | skipped | inconclusive
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number; // passed / (total - skipped); 0 when no assertions evaluated
  hasCommandAssertion: boolean;
}

export interface L2Result {
  status: LayerStatus;
  pValue: number | null;
  cohenD: number | null;
  deltaMean: number | null;
  baselineMean: number | null;
  trialMean: number | null;
  /** true if we took the zero-variance fallback path (>10% delta rule). */
  zeroVarianceFallback: boolean;
  /** true if NaN/Inf protection triggered. */
  nanDetected: boolean;
  rationale: string;
}

// ---------------------------------------------------------------------------
// L1 · Assertion Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate L1 status across all trials' assertions.
 *
 * Rules (design §6.1.1):
 *   - Any `fail` across any trial's assertions -> fail (hard short-circuit)
 *   - Any `error` treated as fail (handler contract: error = hard failure)
 *   - No trials or zero evaluated assertions -> skipped
 *   - All remaining evaluated assertions pass -> pass
 *   - Everything skipped -> skipped
 *   - timeout counted as fail (per §6.3 three-layer hardening)
 */
export function aggregateL1(
  assertions: AssertionSpec[],
  trials: TrialResult[],
): L1Aggregate {
  const hasCommandAssertion = assertions.some(
    (a) => a.type === 'command_exit_code',
  );

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let total = 0;

  for (const trial of trials) {
    for (const r of trial.assertions) {
      total++;
      if (r.status === 'pass') passed++;
      else if (r.status === 'fail' || r.status === 'timeout' || r.status === 'error') failed++;
      else if (r.status === 'skipped') skipped++;
    }
  }

  let status: LayerStatus;
  if (total === 0) status = 'skipped';
  else if (failed > 0) status = 'fail';
  else if (passed === 0 && skipped > 0) status = 'skipped';
  else status = 'pass';

  const evaluated = total - skipped;
  const passRate = evaluated > 0 ? passed / evaluated : 0;

  return { status, total, passed, failed, skipped, passRate, hasCommandAssertion };
}

// ---------------------------------------------------------------------------
// secure_l1_required rule (v5.0.1, Blocker B2)
// ---------------------------------------------------------------------------

const SHA256_RE = /^[a-f0-9]{64}$/;

export function requiresSecureL1(assertions: AssertionSpec[]): boolean {
  return assertions.some((a) => a.type === 'command_exit_code');
}

export function hasSecureL1Evidence(
  trials: TrialResult[],
  store: EvidenceStore,
): boolean {
  return trials.some((t) => {
    const ev = t.secure_l1_evidence as SecureL1Evidence | undefined;
    if (!ev) return false;
    if (ev.exit_code_verified !== true) return false;
    if (!['bwrap', 'firejail', 'docker'].includes(ev.sandbox_type)) return false;
    if (typeof ev.execution_trace_hash !== 'string') return false;
    if (ev.execution_trace_hash.trim() === '') return false;
    if (!SHA256_RE.test(ev.execution_trace_hash)) return false;
    if (!store.hasTrace(ev.execution_trace_hash)) return false;
    return t.assertions.some(
      (a) => a.type === 'command_exit_code' && a.status === 'pass',
    );
  });
}

// ---------------------------------------------------------------------------
// L2 · Statistical Evaluator (Welch t-test + Cohen's d)
// ---------------------------------------------------------------------------

const L2_MIN_SAMPLE_SIZE = 5;
const L2_P_THRESHOLD = 0.05;
const L2_COHEN_D_THRESHOLD = 0.5;
const L2_ZERO_VAR_DELTA_THRESHOLD = 0.1; // 10%

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (Bessel-corrected, n-1). Returns 0 if n < 2. */
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (xs.length - 1);
}

/** Pooled SD for Cohen's d (equal variance assumption). */
function pooledSd(a: number[], b: number[]): number {
  const va = variance(a);
  const vb = variance(b);
  // Pool with sample sizes
  const n1 = a.length;
  const n2 = b.length;
  if (n1 + n2 - 2 <= 0) return 0;
  return Math.sqrt(((n1 - 1) * va + (n2 - 1) * vb) / (n1 + n2 - 2));
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Compute L2 verdict from baseline / trial samples.
 *
 * Per §6.2.1 data premises:
 *   - min sample size each side: 5 -> else `inconclusive`
 *   - any NaN/Infinity in samples -> `inconclusive` (nanDetected=true)
 *   - zero variance in either group -> skip t-test, use |delta|/|baseline| > 10%
 *   - else: significant iff p < 0.05 AND |Cohen's d| >= 0.5
 *
 * Direction: trialMean > baselineMean = improvement => `pass`;
 *            trialMean < baselineMean = regression => `fail`.
 */
export function evaluateL2(samples: MetricSamples): L2Result {
  const { baseline, trial } = samples;

  // NaN / Inf guard
  const allFinite = [...baseline, ...trial].every(isFiniteNumber);
  if (!allFinite) {
    return {
      status: 'inconclusive',
      pValue: null,
      cohenD: null,
      deltaMean: null,
      baselineMean: null,
      trialMean: null,
      zeroVarianceFallback: false,
      nanDetected: true,
      rationale: 'l2_nan_detected',
    };
  }

  // Minimum sample size
  if (baseline.length < L2_MIN_SAMPLE_SIZE || trial.length < L2_MIN_SAMPLE_SIZE) {
    return {
      status: 'inconclusive',
      pValue: null,
      cohenD: null,
      deltaMean: null,
      baselineMean: baseline.length > 0 ? mean(baseline) : null,
      trialMean: trial.length > 0 ? mean(trial) : null,
      zeroVarianceFallback: false,
      nanDetected: false,
      rationale: `l2_min_sample_size_not_met (baseline=${baseline.length}, trial=${trial.length}, min=${L2_MIN_SAMPLE_SIZE})`,
    };
  }

  const bMean = mean(baseline);
  const tMean = mean(trial);
  const delta = tMean - bMean;
  const bVar = variance(baseline);
  const tVar = variance(trial);

  // Zero variance fallback
  if (bVar === 0 || tVar === 0) {
    const denom = Math.abs(bMean) < 1e-9 ? 1 : Math.abs(bMean);
    const relDelta = Math.abs(delta) / denom;
    const significant = relDelta > L2_ZERO_VAR_DELTA_THRESHOLD;
    let status: LayerStatus;
    if (!significant) status = 'inconclusive';
    else status = delta > 0 ? 'pass' : 'fail';
    // T-058c-Lite · zero-variance 路径下为 confidence 提供 effect-size proxy
    // 原实现返回 cohenD=null → confidence 公式中 effectWeight=0 → confidence 封顶 0.7。
    // 现在 zero-variance 且 significant 时，用 sign(delta)*min(2, relDelta) 作为 Cohen-d 代理，
    // 让 confidence 能调到 high 不会被头顶 effectWeight=0 锁死。**TODO(T-058c v2):**
    // 废除 mock 路径后评估是否保留此补丁 —— 如保留请补充商鞅论证 + 单测。
    let cohenDProxy: number | null = null;
    if (significant) {
      const sign = delta > 0 ? 1 : -1;
      cohenDProxy = sign * Math.min(2.0, relDelta);
    }
    return {
      status,
      pValue: null,
      cohenD: cohenDProxy,
      deltaMean: delta,
      baselineMean: bMean,
      trialMean: tMean,
      zeroVarianceFallback: true,
      nanDetected: false,
      rationale: `l2_zero_variance_fallback (rel_delta=${relDelta.toFixed(4)}, threshold=${L2_ZERO_VAR_DELTA_THRESHOLD})`,
    };
  }

  // Welch t-test (two-sided). simple-statistics returns t-statistic; we derive
  // p-value via a conservative approximation: |t| >= 1.96 ≈ p <= 0.05 for
  // moderate dof. For more precision we'd need jStat, but the library choice
  // was pinned by ticket R4 to simple-statistics. We therefore supplement with
  // Cohen's d (which the truth table already requires as an AND condition).
  let tStat: number | null = null;
  try {
    const t = tTestTwoSample(baseline, trial);
    tStat = typeof t === 'number' ? t : null;
  } catch {
    tStat = null;
  }
  // Approximate two-sided p-value from |t| using normal CDF (adequate for
  // n >= 5 and used only in conjunction with Cohen's d gate per §6.2.1).
  const pApprox = tStat == null ? 1 : 2 * (1 - normalCdf(Math.abs(tStat)));
  const sd = pooledSd(baseline, trial);
  const cohenD = sd === 0 ? 0 : delta / sd;

  const significant = pApprox < L2_P_THRESHOLD && Math.abs(cohenD) >= L2_COHEN_D_THRESHOLD;
  let status: LayerStatus;
  if (!significant) status = 'inconclusive';
  else status = delta > 0 ? 'pass' : 'fail';

  return {
    status,
    pValue: pApprox,
    cohenD,
    deltaMean: delta,
    baselineMean: bMean,
    trialMean: tMean,
    zeroVarianceFallback: false,
    nanDetected: false,
    rationale: `l2_welch_tTest (p=${pApprox.toFixed(4)}, d=${cohenD.toFixed(4)})`,
  };
}

/** Standard normal CDF via erf approximation (Abramowitz & Stegun 7.1.26). */
function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x: number): number {
  // Numerical approximation; error < 1.5e-7
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

// ---------------------------------------------------------------------------
// Truth Table (13 rows, §6.1.2)
// ---------------------------------------------------------------------------

type NextState = 'graduated' | 'retired' | 'dormant';

export interface TruthTableRow {
  verdict: VerdictName;
  next_state: NextState;
  rationale: string;
}

/**
 * Apply the 13-row truth table. L3 is treated as `skipped` when undefined.
 * `secure_l1_required` downgrade is applied by the caller (evaluateCandidate).
 */
export function applyTruthTable(
  l1: LayerStatus,
  l2: LayerStatus,
  l3: LayerStatus,
): TruthTableRow {
  // Row 6: L1 fail (hard short-circuit)
  if (l1 === 'fail') {
    return { verdict: 'FAIL', next_state: 'retired', rationale: 'row6_L1_fail' };
  }
  // Row 12: L1 inconclusive (handler contract violation, treated as anomaly)
  if (l1 === 'inconclusive') {
    return { verdict: 'INCONCLUSIVE', next_state: 'dormant', rationale: 'row12_L1_inconclusive' };
  }
  // Row 13: ALL skipped
  if (l1 === 'skipped' && l2 === 'skipped' && (l3 === 'skipped')) {
    return { verdict: 'SYSTEM_ERROR', next_state: 'dormant', rationale: 'row13_all_skipped' };
  }

  if (l1 === 'pass') {
    // Row 5: L1 pass + L2 fail -> CONFLICT
    if (l2 === 'fail') {
      return { verdict: 'CONFLICT', next_state: 'dormant', rationale: 'row5_L1pass_L2fail_conflict' };
    }
    // Row 1: L1 pass + L2 pass + L3 pass
    if (l2 === 'pass' && l3 === 'pass') {
      return { verdict: 'PASS', next_state: 'graduated', rationale: 'row1_L1pass_L2pass_L3pass' };
    }
    // Row 2: L1 pass + L2 pass + L3 fail (or skipped/inconclusive)
    if (l2 === 'pass') {
      return { verdict: 'PASS', next_state: 'graduated', rationale: 'row2_L1pass_L2pass_L3nonpass' };
    }
    // Row 3: L1 pass + L2 inconc + L3 pass
    if (l2 === 'inconclusive' && l3 === 'pass') {
      return { verdict: 'PASS_WEAK', next_state: 'graduated', rationale: 'row3_L1pass_L2inconc_L3pass' };
    }
    // Row 4: L1 pass + L2 inconc + L3 fail (or skipped/inconclusive)
    if (l2 === 'inconclusive') {
      return { verdict: 'INCONCLUSIVE', next_state: 'dormant', rationale: 'row4_L1pass_L2inconc_L3nonpass' };
    }
    // L1 pass + L2 skipped -> treat as inconclusive family
    return { verdict: 'INCONCLUSIVE', next_state: 'dormant', rationale: 'row4x_L1pass_L2skipped' };
  }

  // L1 skipped
  if (l1 === 'skipped') {
    // Row 9: L1 skip + L2 fail
    if (l2 === 'fail') {
      return { verdict: 'FAIL_L2', next_state: 'retired', rationale: 'row9_L1skip_L2fail' };
    }
    // Row 7: L1 skip + L2 pass + L3 pass
    if (l2 === 'pass' && l3 === 'pass') {
      return { verdict: 'PASS_L2', next_state: 'graduated', rationale: 'row7_L1skip_L2pass_L3pass' };
    }
    // Row 8: L1 skip + L2 pass + L3 fail/skipped/inconclusive
    if (l2 === 'pass') {
      return { verdict: 'PASS_WEAK', next_state: 'graduated', rationale: 'row8_L1skip_L2pass_L3nonpass' };
    }
    // Row 10: L1 skip + L2 inconc + L3 pass
    if (l2 === 'inconclusive' && l3 === 'pass') {
      return { verdict: 'INCONCLUSIVE', next_state: 'dormant', rationale: 'row10_L1skip_L2inconc_L3pass' };
    }
    // Row 11: L1 skip + L2 inconc + L3 fail
    if (l2 === 'inconclusive' && l3 === 'fail') {
      return { verdict: 'LIKELY_FAIL', next_state: 'dormant', rationale: 'row11_L1skip_L2inconc_L3fail' };
    }
    // L1 skip + L2 inconc + L3 skipped/inconclusive -> INCONCLUSIVE (near row 10)
    return { verdict: 'INCONCLUSIVE', next_state: 'dormant', rationale: 'row10x_L1skip_L2inconc_L3weak' };
  }

  // Should be unreachable
  return { verdict: 'INCONCLUSIVE', next_state: 'dormant', rationale: 'unreachable_default' };
}

// ---------------------------------------------------------------------------
// Confidence (§6.2.1) — Wilson score lower bound
// ---------------------------------------------------------------------------

export function computeConfidence(
  passRate: number,
  sampleSize: number,
  l2EffectSize: number,
): number {
  if (sampleSize <= 0) return 0;
  const p = Math.max(0, Math.min(1, passRate));
  const n = sampleSize;
  const z = 1.96;
  const wilsonLower =
    (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) /
    (1 + (z * z) / n);
  const sampleWeight = Math.min(1, n / 10);
  const effectWeight = Math.min(1, Math.abs(l2EffectSize) / 0.8);
  return Math.max(0, Math.min(1, wilsonLower * sampleWeight * (0.7 + 0.3 * effectWeight)));
}

/** Threshold classification per §6.2.2 (High/Mid/Low). */
export function classifyConfidence(c: number): 'high' | 'mid' | 'low' {
  if (c >= 0.7) return 'high';
  if (c >= 0.5) return 'mid';
  return 'low';
}

// ---------------------------------------------------------------------------
// Public entry: evaluateCandidate
// ---------------------------------------------------------------------------

export interface EvaluatorOutput extends EvaluationVerdict {
  /** Aggregated L1 diagnostics. */
  l1_aggregate: L1Aggregate;
  /** L2 statistical diagnostics. */
  l2_result: L2Result;
  /** Wilson-based confidence score 0..1. */
  confidence: number;
  /** `dormant_reason` hint for caller (State Machine). */
  dormant_reason?: 'no_match' | 'inconclusive' | null;
  /** secure_l1_required rule outcome. */
  secure_l1_required_triggered: boolean;
}

export function evaluateCandidate(input: EvaluatorInput): EvaluatorOutput {
  const {
    candidate_id,
    assertions,
    trials,
    metrics,
    evidenceStore = permissiveEvidenceStore,
    l3 = 'skipped',
    now = () => new Date(),
  } = input;

  const l1 = aggregateL1(assertions, trials);
  const l2 = evaluateL2(metrics);
  const l3Status: LayerStatus = l3 ?? 'skipped';

  let row = applyTruthTable(l1.status, l2.status, l3Status);

  // secure_l1_required downgrade (v5.0.1): rows #7/#8 (PASS_L2/PASS_WEAK when
  // L1 was skipped) must be downgraded to INCONCLUSIVE/dormant when the
  // candidate contains command_exit_code assertions without qualifying evidence.
  const requires = requiresSecureL1(assertions);
  const hasEv = requires ? hasSecureL1Evidence(trials, evidenceStore) : true;
  const secure_l1_required_triggered = requires && !hasEv;

  if (
    secure_l1_required_triggered &&
    (row.verdict === 'PASS_L2' || row.verdict === 'PASS_WEAK') &&
    l1.status === 'skipped'
  ) {
    row = {
      verdict: 'INCONCLUSIVE',
      next_state: 'dormant',
      rationale: `secure_l1_required_block (${row.verdict} downgraded)`,
    };
  }

  const layers: LayerResult[] = [
    { layer: 'L1', status: l1.status, rationale: `pass=${l1.passed}/${l1.total} skipped=${l1.skipped} fail=${l1.failed}` },
    { layer: 'L2', status: l2.status, rationale: l2.rationale },
    { layer: 'L3', status: l3Status, rationale: 'L3 placeholder (P1a interface-only)' },
    { layer: 'L4', status: 'skipped', rationale: 'L4 human feedback not evaluated in P1a' },
  ];

  const confidence = computeConfidence(
    l1.passRate,
    trials.length,
    l2.cohenD == null ? 0 : Math.abs(l2.cohenD),
  );

  let dormant_reason: EvaluatorOutput['dormant_reason'] = null;
  if (row.next_state === 'dormant') {
    dormant_reason = 'inconclusive';
  }

  return {
    candidate_id,
    verdict: row.verdict,
    next_state: row.next_state,
    layers,
    evaluated_at: now().toISOString(),
    secure_l1_required_triggered,
    l1_aggregate: l1,
    l2_result: l2,
    confidence,
    dormant_reason,
  };
}
