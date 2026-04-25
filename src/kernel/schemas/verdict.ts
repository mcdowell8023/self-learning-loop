/**
 * Evaluation verdict types for the Decision Layer.
 * Ref: learning-loop-design-v5.0.3.md §6.1
 * @module
 */
import { z } from 'zod';

// ─── Verdict Names (13-row truth table) ─────────────

/**
 * All possible verdict names from the 4-layer truth table. §6.1.2
 *
 * - PASS / PASS_WEAK / PASS_L2: graduation paths
 * - FAIL / FAIL_L2: retirement paths
 * - INCONCLUSIVE / LIKELY_FAIL: dormant paths
 * - CONFLICT: dormant (signal conflict)
 * - SYSTEM_ERROR: dormant + alert
 */
export const VerdictNameSchema = z.enum([
  'PASS',
  'PASS_WEAK',
  'PASS_L2',
  'FAIL',
  'FAIL_L2',
  'INCONCLUSIVE',
  'LIKELY_FAIL',
  'CONFLICT',
  'SYSTEM_ERROR',
]);

export type VerdictName = z.infer<typeof VerdictNameSchema>;

// ─── Layer Status ───────────────────────────────────

/** Status of a single evaluation layer. */
export const LayerStatusSchema = z.enum([
  'pass',
  'fail',
  'inconclusive',
  'skipped',
]);

export type LayerStatus = z.infer<typeof LayerStatusSchema>;

// ─── Evaluation Verdict ─────────────────────────────

/** Per-layer result detail. */
export const LayerResultSchema = z.object({
  /** Layer identifier. */
  layer: z.enum(['L1', 'L2', 'L3', 'L4']),

  /** Layer evaluation status. */
  status: LayerStatusSchema,

  /** Confidence score (0-1, optional). */
  confidence: z.number().min(0).max(1).optional(),

  /** Human-readable rationale. */
  rationale: z.string().optional(),
});

export type LayerResult = z.infer<typeof LayerResultSchema>;

/** §6.1 EvaluationVerdict — output of the Four-Layer Evaluator. */
export const EvaluationVerdictSchema = z.object({
  /** Candidate being evaluated. */
  candidate_id: z.string(),

  /** Final verdict name. */
  verdict: VerdictNameSchema,

  /** Recommended next state for the candidate. */
  next_state: z.enum(['graduated', 'retired', 'dormant']),

  /** Per-layer results. */
  layers: z.array(LayerResultSchema),

  /** Timestamp of evaluation. */
  evaluated_at: z.string(),

  /** Whether secure_l1_required rule was triggered. */
  secure_l1_required_triggered: z.boolean().optional(),
});

export type EvaluationVerdict = z.infer<typeof EvaluationVerdictSchema>;
