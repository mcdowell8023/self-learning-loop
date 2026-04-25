/**
 * Audit event types for JSONL logging (P1b).
 * @module
 */
import { z } from 'zod';
/** Audit event — append-only JSONL record for observability. */
export declare const AuditEventSchema: z.ZodObject<{
    /** Event ID (UUID or content-addressable). */
    event_id: z.ZodString;
    /** Event type. */
    type: z.ZodString;
    /** ISO 8601 timestamp. */
    timestamp: z.ZodString;
    /** Related candidate ID (if applicable). */
    candidate_id: z.ZodOptional<z.ZodString>;
    /** Related trial ID (if applicable). */
    trial_id: z.ZodOptional<z.ZodString>;
    /** Actor (system | user | adapter name). */
    actor: z.ZodString;
    /** Free-form event data. */
    data: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    /** Human-readable summary. */
    summary: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: string;
    timestamp: string;
    event_id: string;
    actor: string;
    data: Record<string, unknown>;
    candidate_id?: string | undefined;
    trial_id?: string | undefined;
    summary?: string | undefined;
}, {
    type: string;
    timestamp: string;
    event_id: string;
    actor: string;
    candidate_id?: string | undefined;
    trial_id?: string | undefined;
    data?: Record<string, unknown> | undefined;
    summary?: string | undefined;
}>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
