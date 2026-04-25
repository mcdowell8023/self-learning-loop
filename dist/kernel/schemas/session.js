/**
 * Session-related types for the Collection Layer.
 * Ref: learning-loop-design-v5.0.3.md §4.1
 * @module
 */
import { z } from 'zod';
// ─── Schemas ────────────────────────────────────────
/** Known event types. `string` fallback allows Adapter extensions. */
export const SessionEventTypeSchema = z.union([
    z.enum([
        'user_message',
        'assistant_message',
        'tool_call',
        'tool_result',
        'error',
        'system',
    ]),
    z.string(),
]);
/** §4.1.3 SessionEvent Schema */
export const SessionEventSchema = z.object({
    /** Event type (required). Adapter extensions use arbitrary strings. */
    type: SessionEventTypeSchema,
    /** Event timestamp (required). Accepts ISO string, serializes as string. */
    timestamp: z.coerce.date(),
    /** Event content text (required). */
    content: z.string(),
    /** Structured metadata (required, at least empty object). */
    metadata: z.record(z.unknown()),
    /** Content hash for dedup (computed by collection layer). */
    contentHash: z.string().optional(),
    /** Raw original event (optional, debug / Adapter extension point). */
    raw: z.unknown().optional(),
}).passthrough(); // §4.5.3 extension passthrough — unknown fields preserved
/** §4.1.2 SessionRef Schema */
export const SessionRefSchema = z.object({
    /** Full path to the session file. */
    path: z.string(),
    /** Runtime adapter ID. */
    runtime: z.string(),
    /** Unique session identifier. */
    sessionId: z.string(),
    /** Session start time. */
    startedAt: z.coerce.date(),
    /** File size in bytes. */
    byteSize: z.number().int().nonnegative(),
    /** Last read offset for incremental collection. */
    lastOffset: z.number().int().nonnegative().optional(),
    /** Adapter-specific metadata. */
    metadata: z.record(z.unknown()).optional(),
});
/** §4.1.4 EnvFingerprint Schema */
export const EnvFingerprintSchema = z.object({
    /** Runtime identifier (required). */
    runtime: z.string(),
    /** Runtime version (optional, Adapter extension). */
    runtimeVersion: z.string().optional(),
    /** OS platform (required). */
    platform: z.enum(['linux', 'darwin', 'win32']),
    /** CPU architecture (required). */
    arch: z.enum(['x64', 'arm64']),
    /** Model used (optional, Adapter extension). */
    model: z.string().optional(),
    /** Node.js version (optional). */
    nodeVersion: z.string().optional(),
    /** Open extension fields (v5.0.1 fix: explicit extensions instead of index signature). */
    extensions: z.record(z.unknown()).optional(),
});
