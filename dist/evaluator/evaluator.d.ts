import type { AssertionSpec, EvaluationVerdict, LayerStatus, TrialResult, VerdictName } from '../kernel/types.js';
/**
 * Append-only store that maps a SHA-256 trace hash back to an audit trail.
 * Evaluator only needs `hasTrace()`; real implementation ships with P1b.
 */
export interface EvidenceStore {
    hasTrace(traceHash: string): boolean;
}
/** Stub evidence store that accepts any non-empty SHA-256 string. */
export declare const permissiveEvidenceStore: EvidenceStore;
/** Caller-supplied L3 signal. `undefined` = not evaluated (treated as skipped). */
export type L3Signal = 'pass' | 'fail' | 'inconclusive' | 'skipped' | undefined;
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
    status: LayerStatus;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number;
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
export declare function aggregateL1(assertions: AssertionSpec[], trials: TrialResult[]): L1Aggregate;
export declare function requiresSecureL1(assertions: AssertionSpec[]): boolean;
export declare function hasSecureL1Evidence(trials: TrialResult[], store: EvidenceStore): boolean;
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
export declare function evaluateL2(samples: MetricSamples): L2Result;
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
export declare function applyTruthTable(l1: LayerStatus, l2: LayerStatus, l3: LayerStatus): TruthTableRow;
export declare function computeConfidence(passRate: number, sampleSize: number, l2EffectSize: number): number;
/** Threshold classification per §6.2.2 (High/Mid/Low). */
export declare function classifyConfidence(c: number): 'high' | 'mid' | 'low';
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
export declare function evaluateCandidate(input: EvaluatorInput): EvaluatorOutput;
export {};
