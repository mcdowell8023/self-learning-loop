// src/orchestrator/cycle.ts
//
// T-058a · Main learning-loop orchestrator.
//
// Wires together:
//   1. RuntimeAdapter discovery (registry.getAdapter)
//   2. Session enumeration (adapter.listNewSessions + extractEvents)
//   3. ShadowRunner.observe — drives trial collection on validating candidates
//   4. EvaluatorInput plumbing (./evaluator-input-builder)
//   5. evaluateCandidate() invocation when trial_count >= min_trials
//   6. Verdict-driven state transitions (graduate / retire / dormant / conflict)
//   7. Confidence three-tier gating (§6.2):
//        high (>= cfg.high)  → automatic next_state per truth-table
//        mid  (low..high)    → wait for more trials (no transition)
//        low  (< cfg.low)    → mark as needs_human_review (returned in report;
//                              persistence deferred to a later ticket — plan
//                              §A2 hardening, not in T-058a scope)
//
// SCOPE NOTE (T-058a only):
//   - No cron / hook wiring (plan §A3 deferred to later ticket).
//   - No L3 LLM Judge (plan §A2 — caller may inject a stub via runCycle.judge).
//   - No BaselineMetricStore (plan §A2 — baseline is opts.baselineProvider or [],
//     evaluator's L2 returns `skipped` when empty; truth table still resolves).
//   - No persistence of needs_human_review flag (returned in report only).

import { getAdapter, listBuiltinRuntimes } from '../adapters/registry.js';
import type { CandidateStore } from '../store/candidate-store.js';
import type { TrialCollector } from '../shadow/trial-collector.js';
import type { ShadowRunner } from '../shadow/shadow-runner.js';
import type { Candidate, EnvFingerprint, TrialResult } from '../kernel/types.js';
import type { SessionEvent } from '../kernel/schemas/session.js';

import {
  evaluateCandidate,
  type EvaluatorOutput,
} from '../evaluator/evaluator.js';
import {
  buildEvaluatorInput,
  type L3JudgeFn,
} from './evaluator-input-builder.js';
import {
  graduateCandidate,
  retireCandidate,
  dormantCandidate,
  conflictCandidate,
} from './graduate.js';
import type { GraduationExecutor } from '../graduation/executor.js';

// ---------------------------------------------------------------------------
// Config + options
// ---------------------------------------------------------------------------

/** Subset of ShadowConfig the cycle reads. Decoupled to allow caller injection. */
export interface CycleThresholds {
  min_trials: number;
  max_trials: number;
  /** Confidence three-tier thresholds (defaults: high=0.7, low=0.5). */
  high: number;
  low: number;
}

export interface CycleOptions {
  store: CandidateStore;
  collector: TrialCollector;
  runner: ShadowRunner;
  /** Required for graduate routing. */
  executor: GraduationExecutor;

  /** Runtime adapters to enumerate. Defaults to ['openclaw']. */
  runtimes?: string[];

  /** Watermark for adapter.listNewSessions(since). Defaults to epoch start. */
  since?: Date;

  /**
   * Optional baseline samples provider (per candidate). When omitted,
   * baseline = [] and L2 will short-circuit to `skipped`.
   */
  baselineProvider?: (candidateId: string) => number[] | Promise<number[]>;

  /** Optional L3 LLM Judge. */
  judge?: L3JudgeFn;

  /** Confidence thresholds + min/max trial counts. */
  thresholds: CycleThresholds;

  /**
   * Dry-run mode: if true, evaluations and verdicts are computed but no
   * state transitions / no graduation file writes are performed.
   */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

export type CandidateOutcome =
  | { status: 'observed_only'; trial_count: number; reason: string }
  | {
      status: 'graduated';
      verdict: EvaluatorOutput['verdict'];
      confidence: number;
      content_hash?: string;
    }
  | {
      status: 'retired';
      verdict: EvaluatorOutput['verdict'];
      confidence: number;
    }
  | {
      status: 'dormant';
      verdict: EvaluatorOutput['verdict'];
      confidence: number;
      dormant_reason: 'no_match' | 'inconclusive';
    }
  | {
      status: 'conflict';
      verdict: EvaluatorOutput['verdict'];
      confidence: number;
    }
  | {
      status: 'needs_human_review';
      verdict: EvaluatorOutput['verdict'];
      confidence: number;
      reason: 'low_confidence';
    }
  | {
      status: 'awaiting_more_trials';
      verdict: EvaluatorOutput['verdict'];
      confidence: number;
      reason: 'mid_confidence';
    }
  | { status: 'error'; error: string };

export interface CycleSessionReport {
  runtime: string;
  sessionId: string;
  candidatesChecked: number;
  matchedCount: number;
  trialsWritten: number;
}

export interface CycleCandidateReport {
  candidate_id: string;
  outcome: CandidateOutcome;
}

export interface CycleReport {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  sessions: CycleSessionReport[];
  candidates: CycleCandidateReport[];
  /** Adapter-level errors (continue-on-error). */
  errors: Array<{ runtime: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectSessionEvents(
  events: AsyncIterable<SessionEvent>,
): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
  }
  return out;
}

/** Convert a parsed LearnConfig.shadow + confidence_thresholds into CycleThresholds. */
export function thresholdsFromConfig(
  shadow: { min_trials: number; max_trials: number },
  high = 0.7,
  low = 0.5,
): CycleThresholds {
  return {
    min_trials: shadow.min_trials,
    max_trials: shadow.max_trials,
    high,
    low,
  };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runCycle(opts: CycleOptions): Promise<CycleReport> {
  const startedAt = new Date().toISOString();
  const runtimes = opts.runtimes ?? ['openclaw']; // Default minimal; T-058b/c add more.
  const since = opts.since ?? new Date(0);

  const sessions: CycleSessionReport[] = [];
  const errors: CycleReport['errors'] = [];

  // -------- (1) Enumerate sessions per runtime + observe --------
  for (const runtimeId of runtimes) {
    if (!listBuiltinRuntimes().includes(runtimeId as never)) {
      // Tolerant: skip unknown runtimes with a warning entry.
      errors.push({ runtime: runtimeId, error: 'runtime not registered' });
      continue;
    }
    let adapter;
    try {
      adapter = await getAdapter(runtimeId);
    } catch (err) {
      errors.push({ runtime: runtimeId, error: String((err as Error).message ?? err) });
      continue;
    }

    let canRun: boolean;
    try {
      canRun = await adapter.detect();
    } catch (err) {
      errors.push({ runtime: runtimeId, error: `detect: ${String(err)}` });
      continue;
    }
    if (!canRun) continue;

    let env: EnvFingerprint;
    try {
      env = await adapter.getEnvFingerprint();
    } catch (err) {
      errors.push({ runtime: runtimeId, error: `env: ${String(err)}` });
      continue;
    }

    let refs;
    try {
      refs = await adapter.listNewSessions(since);
    } catch (err) {
      errors.push({ runtime: runtimeId, error: `listNewSessions: ${String(err)}` });
      continue;
    }

    for (const ref of refs) {
      try {
        const events = await collectSessionEvents(adapter.extractEvents(ref));
        const obs = opts.runner.observe(ref.sessionId, events, env);
        sessions.push({
          runtime: runtimeId,
          sessionId: ref.sessionId,
          candidatesChecked: obs.candidatesChecked,
          matchedCount: obs.matchedCount,
          trialsWritten: obs.trialsWritten,
        });
      } catch (err) {
        errors.push({
          runtime: runtimeId,
          error: `session ${ref.sessionId}: ${String(err)}`,
        });
      }
    }
  }

  // Flush any buffered trials before evaluating.
  opts.collector.flush();

  // -------- (2) Evaluate every validating candidate that has enough trials --------
  const candidatesReport: CycleCandidateReport[] = [];
  const validating: Candidate[] = opts.store.list({ state: 'validating' });

  for (const c of validating) {
    try {
      const stats = opts.collector.getStats(c.candidate_id);

      if (stats.trial_count < opts.thresholds.min_trials) {
        candidatesReport.push({
          candidate_id: c.candidate_id,
          outcome: {
            status: 'observed_only',
            trial_count: stats.trial_count,
            reason: `trial_count<${opts.thresholds.min_trials}`,
          },
        });
        continue;
      }

      // Pull baseline if a provider was supplied.
      const baseline = opts.baselineProvider
        ? await opts.baselineProvider(c.candidate_id)
        : [];

      const input = await buildEvaluatorInput(
        c.candidate_id,
        opts.store,
        opts.collector,
        { baseline, judge: opts.judge },
      );
      const result = evaluateCandidate(input);

      const outcome = await applyVerdict({
        candidate: c,
        result,
        trialCount: stats.trial_count,
        trials: input.trials,
        thresholds: opts.thresholds,
        store: opts.store,
        executor: opts.executor,
        dryRun: opts.dryRun ?? false,
      });

      candidatesReport.push({ candidate_id: c.candidate_id, outcome });
    } catch (err) {
      candidatesReport.push({
        candidate_id: c.candidate_id,
        outcome: { status: 'error', error: String((err as Error).message ?? err) },
      });
    }
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: opts.dryRun ?? false,
    sessions,
    candidates: candidatesReport,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Verdict → state transition + graduation routing
// ---------------------------------------------------------------------------

interface ApplyVerdictArgs {
  candidate: Candidate;
  result: EvaluatorOutput;
  trialCount: number;
  trials: TrialResult[];
  thresholds: CycleThresholds;
  store: CandidateStore;
  executor: GraduationExecutor;
  dryRun: boolean;
}

async function applyVerdict(args: ApplyVerdictArgs): Promise<CandidateOutcome> {
  const { candidate, result, trialCount, thresholds, store, executor, dryRun } = args;
  const conf = result.confidence;

  // Always-terminal verdicts that don't gate on confidence:
  //   - SYSTEM_ERROR is unconditional dormant + alert (caller-driven alert TBD).
  //   - At max_trials, force decision regardless of confidence.
  const atMax = trialCount >= thresholds.max_trials;

  // ---- Confidence three-tier gating ----
  // Mid confidence with non-terminal verdict and trial_count < max_trials → wait.
  if (
    !atMax &&
    result.verdict !== 'FAIL' &&
    result.verdict !== 'FAIL_L2' &&
    result.verdict !== 'SYSTEM_ERROR' &&
    conf >= thresholds.low &&
    conf < thresholds.high
  ) {
    return {
      status: 'awaiting_more_trials',
      verdict: result.verdict,
      confidence: conf,
      reason: 'mid_confidence',
    };
  }

  // Low confidence + non-fatal verdict: queue for human review (NOT persisted in T-058a).
  if (
    !atMax &&
    result.verdict !== 'FAIL' &&
    result.verdict !== 'FAIL_L2' &&
    result.verdict !== 'SYSTEM_ERROR' &&
    conf < thresholds.low
  ) {
    return {
      status: 'needs_human_review',
      verdict: result.verdict,
      confidence: conf,
      reason: 'low_confidence',
    };
  }

  // ---- High confidence (or atMax / fatal): apply truth-table next_state ----
  switch (result.next_state) {
    case 'graduated': {
      if (dryRun) {
        return { status: 'graduated', verdict: result.verdict, confidence: conf };
      }
      try {
        const r = graduateCandidate({
          candidate,
          evalResult: result,
          trialCount,
          executor,
        });
        return {
          status: 'graduated',
          verdict: result.verdict,
          confidence: conf,
          content_hash: r.content_hash,
        };
      } catch (err) {
        return {
          status: 'error',
          error: `graduate failed: ${String((err as Error).message ?? err)}`,
        };
      }
    }
    case 'retired': {
      if (!dryRun) {
        retireCandidate(store, candidate, result.verdict);
      }
      return { status: 'retired', verdict: result.verdict, confidence: conf };
    }
    case 'dormant': {
      // CONFLICT verdict routes to `conflict` state (not dormant).
      if (result.verdict === 'CONFLICT') {
        if (!dryRun) conflictCandidate(store, candidate, result.verdict);
        return { status: 'conflict', verdict: result.verdict, confidence: conf };
      }
      const reason: 'no_match' | 'inconclusive' =
        result.dormant_reason === 'no_match' ? 'no_match' : 'inconclusive';
      if (!dryRun) dormantCandidate(store, candidate, reason, result.verdict);
      return {
        status: 'dormant',
        verdict: result.verdict,
        confidence: conf,
        dormant_reason: reason,
      };
    }
    default: {
      return {
        status: 'error',
        error: `unknown next_state: ${result.next_state}`,
      };
    }
  }
}
