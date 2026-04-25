/**
 * Trial result types for Shadow Runner.
 * Ref: learning-loop-design-v5.0.3.md §5.5
 * @module
 */
import { z } from 'zod';
import { EnvFingerprintSchema } from './session.js';

// ─── Assertion Result ───────────────────────────────

/** Status of a single assertion execution. */
export const AssertionStatusSchema = z.enum([
  'pass',
  'fail',
  'timeout',
  'error',
  'skipped',
]);

export type AssertionStatus = z.infer<typeof AssertionStatusSchema>;

/** Result of executing one assertion during a trial. */
export const AssertionResultSchema = z.object({
  /** Assertion type. */
  type: z.string(),

  /** Execution status. */
  status: AssertionStatusSchema,

  /** Execution duration in milliseconds. */
  duration_ms: z.number().nonnegative(),

  /** Human-readable detail (error message, etc.). */
  detail: z.string().optional(),
});

export type AssertionResult = z.infer<typeof AssertionResultSchema>;

// ─── Secure L1 Evidence (v5.0.2, closes B2) ────────

/** Sandbox execution evidence. Only filled by Assertion Engine in real sandbox. */
export const SecureL1EvidenceSchema = z.object({
  /** Sandbox backend used. */
  sandbox_type: z.enum(['bwrap', 'firejail', 'docker']),

  /** Whether exit code was verified. */
  exit_code_verified: z.boolean(),

  /** SHA-256 hash of execution trace for audit. */
  execution_trace_hash: z.string(),

  /** Sandbox execution timestamp. */
  timestamp: z.string(),
});

export type SecureL1Evidence = z.infer<typeof SecureL1EvidenceSchema>;

// ─── Trial Metrics ──────────────────────────────────

/** Metrics collected during a single trial. */
export const TrialMetricsSchema = z.object({
  /** Number of conversation turns. */
  turns: z.number().int().nonnegative(),

  /** Number of errors encountered. */
  errors: z.number().int().nonnegative(),

  /** Total token usage. */
  token_usage: z.number().nonnegative(),

  /** Task completion rate (0-1). */
  completion_rate: z.number().min(0).max(1),
});

export type TrialMetrics = z.infer<typeof TrialMetricsSchema>;

// ─── Trial Result ───────────────────────────────────

/** §5.5 TrialResult — one observation in the validation phase. */
export const TrialResultSchema = z.object({
  /** Unique trial ID. */
  trial_id: z.string(),

  /** Associated candidate ID. */
  candidate_id: z.string(),

  /** Session where this trial was observed. */
  session_id: z.string(),

  /** Runtime where trial ran. */
  runtime: z.string(),

  /** Trial start time (ISO 8601). */
  started_at: z.string(),

  /** Trial end time (ISO 8601). */
  completed_at: z.string(),

  /** Assertion results. */
  assertions: z.array(AssertionResultSchema),

  /** Collected metrics. */
  metrics: TrialMetricsSchema,

  /** Environment fingerprint. */
  env_fingerprint: EnvFingerprintSchema,

  /** Sandbox execution evidence (v5.0.2, only present when L1 ran in sandbox). */
  secure_l1_evidence: SecureL1EvidenceSchema.optional(),
});

export type TrialResult = z.infer<typeof TrialResultSchema>;
