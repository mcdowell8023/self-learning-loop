/**
 * Candidate types for the Learning Kernel.
 * Ref: learning-loop-design-v5.0.3.md §5.1 / §5.2
 * @module
 */
import { z } from 'zod';
import { EnvFingerprintSchema } from './session.js';
// ─── State Machine (8-state) ────────────────────────
/**
 * 8-state lifecycle FSM. §5.2.1
 *
 * pending → reviewing → validating → graduated
 *                                  → retired
 *                                  → conflict → validating | retired
 *                                  → dormant  → validating | retired
 *                       → rejected
 */
export const CandidateStateSchema = z.enum([
    'pending',
    'reviewing',
    'validating',
    'conflict',
    'graduated',
    'retired',
    'dormant',
    'rejected',
]);
/** Dormant reason — distinguishes "no matching session" from "conflicting signals". §5.2.1 B3 fix */
export const DormantReasonSchema = z.enum(['no_match', 'inconclusive']);
// ─── Strategy (experience template) ─────────────────
/** §5.1.2 Strategy Schema — reusable experience template. */
export const StrategySchema = z.object({
    /** Content-addressable ID: SHA256(problem_category + trigger_conditions + recommended_action). */
    strategy_id: z.string(),
    /** Problem category. */
    problem_category: z.string(),
    /** When to apply this strategy. */
    trigger_conditions: z.string(),
    /** What to do. */
    recommended_action: z.string(),
    /** Applicability scope. */
    scope: z.union([
        z.enum(['general', 'skill']),
        z.string().startsWith('tool:'),
        z.string().startsWith('role:'),
    ]),
    /** Optional tags. */
    tags: z.array(z.string()).optional(),
    /** Creation timestamp (ISO 8601). */
    created_at: z.string(),
    /** Associated Instance IDs. */
    instance_ids: z.array(z.string()),
});
// ─── Instance (concrete application record) ─────────
/** §5.1.3 Assertion spec embedded in Instance. */
export const AssertionSpecSchema = z.object({
    /** Assertion type. */
    type: z.string(),
    /** Command to run (for command_exit_code type). */
    command: z.string().optional(),
    /** Expected exit code. */
    expected_exit_code: z.number().int().optional(),
    /** Allowed commands (sandbox allowlist). */
    command_allowlist: z.array(z.string()).optional(),
    /** Timeout in ms. */
    timeout_ms: z.number().int().positive().optional(),
    /** Sandbox profile. */
    sandbox_profile: z.string().optional(),
});
/** Source session reference within an Instance. */
export const SourceSessionSchema = z.object({
    session_id: z.string(),
    runtime: z.string(),
    timestamp: z.string(),
});
/** §5.1.3 Instance Schema — concrete application of a Strategy. */
export const InstanceSchema = z.object({
    /** Content-addressable ID: SHA256(strategy_id + diff_summary + runtime). */
    instance_id: z.string(),
    /** Parent Strategy ID. */
    strategy_id: z.string(),
    /** What was actually done. */
    diff_summary: z.string(),
    /** Files touched. */
    files_touched: z.array(z.string()),
    /** Environment fingerprint. */
    env_fingerprint: EnvFingerprintSchema,
    /** Source sessions. */
    source_sessions: z.array(SourceSessionSchema),
    /** Assertion definitions. */
    assertions: z.array(AssertionSpecSchema),
    /** Trial results (populated during validation). */
    trial_results: z.array(z.lazy(() => {
        // Forward ref — TrialResultSchema is in trial.ts.
        // For schema validation within Instance, accept any object here.
        // Full TrialResult validation happens in trial.ts.
        return z.record(z.unknown());
    })),
    /** Creation timestamp (ISO 8601). */
    created_at: z.string(),
});
// ─── Candidate (combined for storage) ───────────────
/** Full candidate record as persisted in SQLite. */
export const CandidateSchema = z.object({
    /** Candidate ID (= strategy_id for now, may diverge). */
    candidate_id: z.string(),
    /** Strategy ID. */
    strategy_id: z.string(),
    /** Current lifecycle state. */
    state: CandidateStateSchema,
    /** Dormant reason (only when state=dormant). */
    dormant_reason: DormantReasonSchema.nullable().optional(),
    /** Full candidate data. */
    data: z.object({
        strategy: StrategySchema,
        instances: z.array(InstanceSchema),
    }),
    /** Created timestamp. */
    created_at: z.string(),
    /** Last updated timestamp. */
    updated_at: z.string(),
});
