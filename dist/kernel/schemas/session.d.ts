/**
 * Session-related types for the Collection Layer.
 * Ref: learning-loop-design-v5.0.3.md §4.1
 * @module
 */
import { z } from 'zod';
/** Known event types. `string` fallback allows Adapter extensions. */
export declare const SessionEventTypeSchema: z.ZodUnion<[z.ZodEnum<["user_message", "assistant_message", "tool_call", "tool_result", "error", "system"]>, z.ZodString]>;
/** §4.1.3 SessionEvent Schema */
export declare const SessionEventSchema: z.ZodObject<{
    /** Event type (required). Adapter extensions use arbitrary strings. */
    type: z.ZodUnion<[z.ZodEnum<["user_message", "assistant_message", "tool_call", "tool_result", "error", "system"]>, z.ZodString]>;
    /** Event timestamp (required). Accepts ISO string, serializes as string. */
    timestamp: z.ZodDate;
    /** Event content text (required). */
    content: z.ZodString;
    /** Structured metadata (required, at least empty object). */
    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    /** Content hash for dedup (computed by collection layer). */
    contentHash: z.ZodOptional<z.ZodString>;
    /** Raw original event (optional, debug / Adapter extension point). */
    raw: z.ZodOptional<z.ZodUnknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    /** Event type (required). Adapter extensions use arbitrary strings. */
    type: z.ZodUnion<[z.ZodEnum<["user_message", "assistant_message", "tool_call", "tool_result", "error", "system"]>, z.ZodString]>;
    /** Event timestamp (required). Accepts ISO string, serializes as string. */
    timestamp: z.ZodDate;
    /** Event content text (required). */
    content: z.ZodString;
    /** Structured metadata (required, at least empty object). */
    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    /** Content hash for dedup (computed by collection layer). */
    contentHash: z.ZodOptional<z.ZodString>;
    /** Raw original event (optional, debug / Adapter extension point). */
    raw: z.ZodOptional<z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    /** Event type (required). Adapter extensions use arbitrary strings. */
    type: z.ZodUnion<[z.ZodEnum<["user_message", "assistant_message", "tool_call", "tool_result", "error", "system"]>, z.ZodString]>;
    /** Event timestamp (required). Accepts ISO string, serializes as string. */
    timestamp: z.ZodDate;
    /** Event content text (required). */
    content: z.ZodString;
    /** Structured metadata (required, at least empty object). */
    metadata: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    /** Content hash for dedup (computed by collection layer). */
    contentHash: z.ZodOptional<z.ZodString>;
    /** Raw original event (optional, debug / Adapter extension point). */
    raw: z.ZodOptional<z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">>;
/** §4.1.2 SessionRef Schema */
export declare const SessionRefSchema: z.ZodObject<{
    /** Full path to the session file. */
    path: z.ZodString;
    /** Runtime adapter ID. */
    runtime: z.ZodString;
    /** Unique session identifier. */
    sessionId: z.ZodString;
    /** Session start time. */
    startedAt: z.ZodDate;
    /** File size in bytes. */
    byteSize: z.ZodNumber;
    /** Last read offset for incremental collection. */
    lastOffset: z.ZodOptional<z.ZodNumber>;
    /** Adapter-specific metadata. */
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    path: string;
    runtime: string;
    sessionId: string;
    startedAt: Date;
    byteSize: number;
    metadata?: Record<string, unknown> | undefined;
    lastOffset?: number | undefined;
}, {
    path: string;
    runtime: string;
    sessionId: string;
    startedAt: Date;
    byteSize: number;
    metadata?: Record<string, unknown> | undefined;
    lastOffset?: number | undefined;
}>;
/** §4.1.4 EnvFingerprint Schema */
export declare const EnvFingerprintSchema: z.ZodObject<{
    /** Runtime identifier (required). */
    runtime: z.ZodString;
    /** Runtime version (optional, Adapter extension). */
    runtimeVersion: z.ZodOptional<z.ZodString>;
    /** OS platform (required). */
    platform: z.ZodEnum<["linux", "darwin", "win32"]>;
    /** CPU architecture (required). */
    arch: z.ZodEnum<["x64", "arm64"]>;
    /** Model used (optional, Adapter extension). */
    model: z.ZodOptional<z.ZodString>;
    /** Node.js version (optional). */
    nodeVersion: z.ZodOptional<z.ZodString>;
    /** Open extension fields (v5.0.1 fix: explicit extensions instead of index signature). */
    extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    runtime: string;
    platform: "linux" | "darwin" | "win32";
    arch: "x64" | "arm64";
    runtimeVersion?: string | undefined;
    model?: string | undefined;
    nodeVersion?: string | undefined;
    extensions?: Record<string, unknown> | undefined;
}, {
    runtime: string;
    platform: "linux" | "darwin" | "win32";
    arch: "x64" | "arm64";
    runtimeVersion?: string | undefined;
    model?: string | undefined;
    nodeVersion?: string | undefined;
    extensions?: Record<string, unknown> | undefined;
}>;
/** A single event from a session. §4.1.3 */
export type SessionEvent = z.infer<typeof SessionEventSchema>;
/** Reference to a discovered session file. §4.1.2 */
export type SessionRef = z.infer<typeof SessionRefSchema>;
/** Environment fingerprint. §4.1.4 */
export type EnvFingerprint = z.infer<typeof EnvFingerprintSchema>;
