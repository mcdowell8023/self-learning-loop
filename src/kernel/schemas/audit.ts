/**
 * Audit event types for JSONL logging (P1b).
 * @module
 */
import { z } from 'zod';

/** Audit event — append-only JSONL record for observability. */
export const AuditEventSchema = z.object({
  /** Event ID (UUID or content-addressable). */
  event_id: z.string(),

  /** Event type. */
  type: z.string(),

  /** ISO 8601 timestamp. */
  timestamp: z.string(),

  /** Related candidate ID (if applicable). */
  candidate_id: z.string().optional(),

  /** Related trial ID (if applicable). */
  trial_id: z.string().optional(),

  /** Actor (system | user | adapter name). */
  actor: z.string(),

  /** Free-form event data. */
  data: z.record(z.unknown()).default({}),

  /** Human-readable summary. */
  summary: z.string().optional(),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;
