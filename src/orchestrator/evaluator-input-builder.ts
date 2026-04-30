// src/orchestrator/evaluator-input-builder.ts
//
// T-058a · EvaluatorInput Plumbing
//
// 把分散在 CandidateStore / TrialCollector 中的数据组装成 evaluator 所需的
// `EvaluatorInput`。设计基准：learning-loop-design-v5.0.5.md §6.1 / §6.2。
//
// 现状（T-058a 范围）：
//   - assertions 来源：candidate.instances[0].assertions（candidate 当前只有 1 个 instance）
//   - trials 来源：TrialCollector.listTrials(candidateId)
//   - metric 主指标：trial.metrics.completion_rate（design §6.1 默认）
//   - baseline samples：当前阶段没有 BaselineMetricStore，注入空数组；evaluator 的
//     L2 会进入 "baseline 不足" 路径，返回 status=skipped、rationale 含说明。
//     这是 plan §A2 在 P1a 范围内的最小实现，BaselineMetricStore 待后续 ticket
//     接入（见 plan §T-058b/c/d/e 与 design §5.4）。
//   - L3 LLM Judge：通过 optional `judge` 回调注入；本范围不实装 LLM 调用，
//     不传则 evaluator 内部按 `l3='skipped'` 路径走（与真值表行 #1/#2/#5 等等价）。
//
// 不在本范围：BaselineMetricStore、L3 LLM Judge 实装、L4 human queue 持久化。

import type { Candidate, TrialResult } from '../kernel/types.js';
import type { CandidateStore } from '../store/candidate-store.js';
import type { TrialCollector } from '../shadow/trial-collector.js';
import type { EvaluatorInput, L3Signal, MetricSamples } from '../evaluator/evaluator.js';

/** Caller-supplied L3 judge. Returning `undefined` ≡ `'skipped'`. */
export type L3JudgeFn = (
  candidate: Candidate,
  trials: TrialResult[],
) => Promise<L3Signal> | L3Signal;

export interface BuildEvaluatorInputOptions {
  /** Override the default metric extractor (defaults to `metrics.completion_rate`). */
  metricExtractor?: (t: TrialResult) => number | null | undefined;
  /**
   * Optional baseline samples for L2 (length should be ≥ 2 for meaningful t-test).
   * When omitted, L2 will short-circuit to `skipped` (no baseline available).
   */
  baseline?: number[];
  /** Optional L3 judge. */
  judge?: L3JudgeFn;
}

/** Default metric: completion_rate (design §6.1 primary metric). */
function defaultMetricExtractor(t: TrialResult): number | undefined {
  return t.metrics?.completion_rate;
}

/**
 * Assemble `EvaluatorInput` for a candidate. Reads from store (candidate +
 * assertions) and collector (trial results), then formats into the shape
 * `evaluateCandidate()` expects.
 *
 * @throws Error if candidate is not found.
 */
export async function buildEvaluatorInput(
  candidateId: string,
  store: CandidateStore,
  collector: TrialCollector,
  opts: BuildEvaluatorInputOptions = {},
): Promise<EvaluatorInput> {
  const candidate = store.get(candidateId);
  if (!candidate) {
    throw new Error(`buildEvaluatorInput: candidate not found: ${candidateId}`);
  }

  // assertions: take the canonical (first) instance's assertion specs.
  const instance = candidate.instances[0];
  const assertions = instance?.assertions ?? [];

  const trials = collector.listTrials(candidateId);

  const extract = opts.metricExtractor ?? defaultMetricExtractor;
  const trialSamples: number[] = [];
  for (const t of trials) {
    const v = extract(t);
    if (typeof v === 'number' && Number.isFinite(v)) {
      trialSamples.push(v);
    }
  }

  const metrics: MetricSamples = {
    baseline: opts.baseline ?? [],
    trial: trialSamples,
  };

  // L3 — call the judge if provided; otherwise leave undefined (= 'skipped').
  let l3: L3Signal | undefined;
  if (opts.judge) {
    try {
      const v = await opts.judge(candidate, trials);
      l3 = v;
    } catch {
      // Judge failure is non-fatal: per plan §A2 降级，super-set to 'skipped'.
      l3 = 'skipped';
    }
  }

  return {
    candidate_id: candidateId,
    assertions,
    trials,
    metrics,
    l3,
  };
}
