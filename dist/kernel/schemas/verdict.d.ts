/**
 * Evaluation verdict types for the Decision Layer.
 * Ref: learning-loop-design-v5.0.3.md §6.1
 * @module
 */
import { z } from 'zod';
/**
 * All possible verdict names from the 4-layer truth table. §6.1.2
 *
 * - PASS / PASS_WEAK / PASS_L2: graduation paths
 * - FAIL / FAIL_L2: retirement paths
 * - INCONCLUSIVE / LIKELY_FAIL: dormant paths
 * - CONFLICT: dormant (signal conflict)
 * - SYSTEM_ERROR: dormant + alert
 */
export declare const VerdictNameSchema: z.ZodEnum<["PASS", "PASS_WEAK", "PASS_L2", "FAIL", "FAIL_L2", "INCONCLUSIVE", "LIKELY_FAIL", "CONFLICT", "SYSTEM_ERROR"]>;
export type VerdictName = z.infer<typeof VerdictNameSchema>;
/** Status of a single evaluation layer. */
export declare const LayerStatusSchema: z.ZodEnum<["pass", "fail", "inconclusive", "skipped"]>;
export type LayerStatus = z.infer<typeof LayerStatusSchema>;
/** Per-layer result detail. */
export declare const LayerResultSchema: z.ZodObject<{
    /** Layer identifier. */
    layer: z.ZodEnum<["L1", "L2", "L3", "L4"]>;
    /** Layer evaluation status. */
    status: z.ZodEnum<["pass", "fail", "inconclusive", "skipped"]>;
    /** Confidence score (0-1, optional). */
    confidence: z.ZodOptional<z.ZodNumber>;
    /** Human-readable rationale. */
    rationale: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    status: "pass" | "fail" | "skipped" | "inconclusive";
    layer: "L1" | "L2" | "L3" | "L4";
    confidence?: number | undefined;
    rationale?: string | undefined;
}, {
    status: "pass" | "fail" | "skipped" | "inconclusive";
    layer: "L1" | "L2" | "L3" | "L4";
    confidence?: number | undefined;
    rationale?: string | undefined;
}>;
export type LayerResult = z.infer<typeof LayerResultSchema>;
/** §6.1 EvaluationVerdict — output of the Four-Layer Evaluator. */
export declare const EvaluationVerdictSchema: z.ZodObject<{
    /** Candidate being evaluated. */
    candidate_id: z.ZodString;
    /** Final verdict name. */
    verdict: z.ZodEnum<["PASS", "PASS_WEAK", "PASS_L2", "FAIL", "FAIL_L2", "INCONCLUSIVE", "LIKELY_FAIL", "CONFLICT", "SYSTEM_ERROR"]>;
    /** Recommended next state for the candidate. */
    next_state: z.ZodEnum<["graduated", "retired", "dormant"]>;
    /** Per-layer results. */
    layers: z.ZodArray<z.ZodObject<{
        /** Layer identifier. */
        layer: z.ZodEnum<["L1", "L2", "L3", "L4"]>;
        /** Layer evaluation status. */
        status: z.ZodEnum<["pass", "fail", "inconclusive", "skipped"]>;
        /** Confidence score (0-1, optional). */
        confidence: z.ZodOptional<z.ZodNumber>;
        /** Human-readable rationale. */
        rationale: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status: "pass" | "fail" | "skipped" | "inconclusive";
        layer: "L1" | "L2" | "L3" | "L4";
        confidence?: number | undefined;
        rationale?: string | undefined;
    }, {
        status: "pass" | "fail" | "skipped" | "inconclusive";
        layer: "L1" | "L2" | "L3" | "L4";
        confidence?: number | undefined;
        rationale?: string | undefined;
    }>, "many">;
    /** Timestamp of evaluation. */
    evaluated_at: z.ZodString;
    /** Whether secure_l1_required rule was triggered. */
    secure_l1_required_triggered: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    candidate_id: string;
    verdict: "PASS" | "PASS_WEAK" | "PASS_L2" | "FAIL" | "FAIL_L2" | "INCONCLUSIVE" | "LIKELY_FAIL" | "CONFLICT" | "SYSTEM_ERROR";
    next_state: "graduated" | "retired" | "dormant";
    layers: {
        status: "pass" | "fail" | "skipped" | "inconclusive";
        layer: "L1" | "L2" | "L3" | "L4";
        confidence?: number | undefined;
        rationale?: string | undefined;
    }[];
    evaluated_at: string;
    secure_l1_required_triggered?: boolean | undefined;
}, {
    candidate_id: string;
    verdict: "PASS" | "PASS_WEAK" | "PASS_L2" | "FAIL" | "FAIL_L2" | "INCONCLUSIVE" | "LIKELY_FAIL" | "CONFLICT" | "SYSTEM_ERROR";
    next_state: "graduated" | "retired" | "dormant";
    layers: {
        status: "pass" | "fail" | "skipped" | "inconclusive";
        layer: "L1" | "L2" | "L3" | "L4";
        confidence?: number | undefined;
        rationale?: string | undefined;
    }[];
    evaluated_at: string;
    secure_l1_required_triggered?: boolean | undefined;
}>;
export type EvaluationVerdict = z.infer<typeof EvaluationVerdictSchema>;
