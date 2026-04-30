// src/orchestrator/graduate.ts
//
// T-058a · Graduation wiring — bridges EvaluatorOutput → GraduationExecutor.
//
// Scope: T-058a/A3 only. Routes a candidate that the evaluator says should
// graduate to GraduationExecutor (which writes AGENTS.md marker block + audit
// yaml + CandidateStore state transition).
//
// Per plan §T-058a/A3 + executor.ts source-of-truth: P1a only `scope: 'general'`
// is supported. Other scopes are loud-rejected by the executor (we propagate
// the error upward; `runCycle` will surface in the report).

import type { Candidate, DormantReason, TrialResult } from '../kernel/types.js';
import type { CandidateStore } from '../store/candidate-store.js';
import {
  GraduationExecutor,
  type GraduateResult,
  type GraduationExecutorOptions,
} from '../graduation/executor.js';
import type { EvaluatorOutput } from '../evaluator/evaluator.js';
import type {
  L1AssertionSummary,
  L2MetricsDelta,
  L3JudgeSummary,
} from '../graduation/graduation-record.js';

// ---------------------------------------------------------------------------
// Markdown body rendering
// ---------------------------------------------------------------------------

/**
 * Render the markdown body that gets injected into AGENTS.md (between marker
 * block) and stored content-addressable at `<graduatedDir>/<hash>.md`.
 *
 * Body is intentionally compact — the marker block already wraps it with
 * provenance metadata; we just need a human-readable summary of the rule.
 */
export function renderGraduatedBody(candidate: Candidate): string {
  const s = candidate.strategy;
  const lines: string[] = [];
  lines.push(`### ${s.problem_category}`);
  lines.push('');
  if (s.summary) {
    lines.push(s.summary);
    lines.push('');
  }
  lines.push(`**触发条件：** ${s.trigger_conditions}`);
  lines.push('');
  lines.push(`**推荐动作：** ${s.recommended_action}`);
  if (s.tags && s.tags.length > 0) {
    lines.push('');
    lines.push(`**标签：** ${s.tags.map((t) => '`' + t + '`').join(' ')}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// EvaluatorOutput → graduation_record.shadow.{l1,l2,l3} adapters
// ---------------------------------------------------------------------------

function adaptL1(out: EvaluatorOutput): L1AssertionSummary {
  return {
    total: out.l1_aggregate.total,
    passed: out.l1_aggregate.passed,
    failed: out.l1_aggregate.failed,
    skipped: out.l1_aggregate.skipped,
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Compute aggregate metric deltas from trial results. The evaluator only
 * runs L2 stat-test on the primary metric (completion_rate by default), but
 * graduation_record schema captures deltas for all four trial metrics for
 * forensic auditing. We compute trial-mean here; baseline is unavailable in
 * T-058a so we report the trial-mean directly as the "delta" surrogate when
 * out.l2_result.trialMean is null. (BaselineMetricStore wiring is out-of-scope.)
 */
function adaptL2(out: EvaluatorOutput, trials: TrialResult[]): L2MetricsDelta {
  const turns = trials.map((t) => t.metrics.turns);
  const errors = trials.map((t) => t.metrics.errors);
  const tokens = trials.map((t) => t.metrics.token_usage);
  // Prefer evaluator's computed delta on the primary metric when available.
  const completionDelta =
    out.l2_result.deltaMean !== null && Number.isFinite(out.l2_result.deltaMean)
      ? out.l2_result.deltaMean
      : mean(trials.map((t) => t.metrics.completion_rate));
  return {
    turns: mean(turns),
    errors: mean(errors),
    token_usage: mean(tokens),
    completion_rate: completionDelta,
  };
}

function adaptL3(out: EvaluatorOutput): L3JudgeSummary {
  const layer = out.layers.find((l) => l.layer === 'L3');
  // Map LayerStatus → L3 verdict tri-value. 'skipped' becomes 'inconclusive'
  // for the audit record (executor still records skipped layer in the rationale).
  let verdict: L3JudgeSummary['verdict'] = 'inconclusive';
  if (layer?.status === 'pass') verdict = 'pass';
  else if (layer?.status === 'fail') verdict = 'fail';
  return {
    verdict,
    confidence: layer?.confidence ?? 0,
    rationale: layer?.rationale,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface GraduateCandidateOptions {
  candidate: Candidate;
  evalResult: EvaluatorOutput;
  trialCount: number;
  /**
   * Trial results used for L2 metrics aggregation. SHOULD be the same set the
   * evaluator consumed (i.e. `collector.listTrials(candidate_id)`), so the
   * audit record reflects exactly what produced the verdict. When omitted we
   * fall back to `candidate.instances[].trial_results` for backwards-compat
   * with callers that don't have a TrialCollector handy (e.g. graduate.spec).
   *
   * Zhang Heng review (P2): cycle.ts now passes `input.trials` here so the
   * graduate path and evaluator path are guaranteed to agree.
   */
  trials?: TrialResult[];
  /** Pre-built executor (e.g. from runCycle); if omitted, a new one is created. */
  executor?: GraduationExecutor;
  /** Required when `executor` is omitted. */
  executorOptions?: GraduationExecutorOptions;
  /** Caller identity recorded in graduation_record. Defaults to 'system'. */
  graduatedBy?: string;
  /** Optional rollback checkpoint. */
  rollbackCheckpoint?: { git_commit?: string | null };
}

/**
 * Wire one candidate through GraduationExecutor.
 *
 * @throws GraduationScopeError if candidate.strategy.scope !== 'general' (P1a).
 *         Caller (runCycle) catches and records as `error` in the cycle report.
 */
export function graduateCandidate(opts: GraduateCandidateOptions): GraduateResult {
  const { candidate, evalResult, trialCount } = opts;

  let executor = opts.executor;
  if (!executor) {
    if (!opts.executorOptions) {
      throw new Error(
        'graduateCandidate: must provide either `executor` or `executorOptions`.',
      );
    }
    executor = new GraduationExecutor(opts.executorOptions);
  }

  const body = renderGraduatedBody(candidate);

  // L2 delta aggregation needs the underlying trials. Prefer the explicitly
  // provided list (from collector, matches what evaluator saw); fall back to
  // candidate.instances[].trial_results for backwards-compat callers.
  const allTrials: TrialResult[] =
    opts.trials ??
    candidate.instances.flatMap((i) => i.trial_results ?? []);

  return executor.graduate({
    candidate,
    body,
    shadow: {
      trial_count: trialCount,
      l1: adaptL1(evalResult),
      l2: adaptL2(evalResult, allTrials),
      l3: adaptL3(evalResult),
    },
    graduated_by: opts.graduatedBy ?? 'system',
    rollbackCheckpoint: opts.rollbackCheckpoint,
  });
}

// ---------------------------------------------------------------------------
// Retire / dormant transition helpers (no executor — pure state transitions)
// ---------------------------------------------------------------------------

/** Drive `validating → retired` transition (FAIL / FAIL_L2 verdicts). */
export function retireCandidate(
  store: CandidateStore,
  candidate: Candidate,
  _rationale: string,
): void {
  if (candidate.state !== 'validating') return;
  store.transition(
    candidate.candidate_id,
    'validating',
    'retired',
    'retire',
    { actor: 'system' },
  );
}

/**
 * Drive `validating → dormant` transition (INCONCLUSIVE / LIKELY_FAIL).
 *
 * NB: DormantReason in T-058a is the kernel-typed two-value enum
 * (`no_match | inconclusive`). CONFLICT verdict is handled by transitioning
 * to the `conflict` state separately (not `dormant`); see runCycle.
 */
export function dormantCandidate(
  store: CandidateStore,
  candidate: Candidate,
  reason: DormantReason,
  _rationale: string,
): void {
  if (candidate.state !== 'validating') return;
  store.transition(
    candidate.candidate_id,
    'validating',
    'dormant',
    'enter_dormant',
    { actor: 'system', dormantReason: reason },
  );
}

/** Drive `validating → conflict` transition (CONFLICT verdict). */
export function conflictCandidate(
  store: CandidateStore,
  candidate: Candidate,
  _rationale: string,
): void {
  if (candidate.state !== 'validating') return;
  store.transition(
    candidate.candidate_id,
    'validating',
    'conflict',
    'enter_conflict',
    { actor: 'system' },
  );
}
