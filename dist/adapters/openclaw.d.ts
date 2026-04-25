import type { EnvFingerprint, SessionEvent, SessionRef } from '../kernel/schemas/session.js';
import { type AuditSink, type RuntimeAdapter } from './base.js';
export interface OpenClawAdapterOptions {
    /**
     * Root directory to scan for OpenClaw sessions. If omitted, the adapter
     * auto-detects the first path that exists from:
     *   1. `~/.openclaw/sessions`
     *   2. `~/.openclaw/agents/main/sessions`
     */
    sessionsDir?: string;
    /** Scan sub-directories one level deep (e.g. `agents/＊/sessions`). Default: true. */
    recursive?: boolean;
    /** Path to persisted offset state. Default: `<workspace>/learn/config/collect-state.json`. */
    stateFilePath?: string;
    /** Workspace root (used to derive default stateFilePath). */
    workspaceDir?: string;
    /** Optional audit sink — receives non-fatal warnings (malformed lines, …). */
    auditSink?: AuditSink;
    /** Model hint for EnvFingerprint (collector may override per-event). */
    model?: string;
}
/** §4.4.2 — SHA-256(type ":" content) truncated to 32 hex chars (128 bit). */
export declare function computeContentHash(event: Pick<SessionEvent, 'type' | 'content'>): string;
/** §4.4.2 — richness scoring used for cross-runtime dedup tie-breaking. */
export declare function envRichnessScore(env: Partial<EnvFingerprint> | undefined | null): number;
interface EventWithEnv extends SessionEvent {
    env_fingerprint?: Partial<EnvFingerprint>;
}
/** §4.4.2 — prefer the event whose env_fingerprint is richer; tie → newer timestamp. */
export declare function preferRicherEnv(existing: EventWithEnv, incoming: EventWithEnv): EventWithEnv;
/** §4.4.2 — dedup events within a 30s window; richer env wins on collision. */
export declare function deduplicateEvents(events: EventWithEnv[], seen?: Map<string, {
    date: Date;
    event: EventWithEnv;
}>): EventWithEnv[];
/**
 * OpenClawAdapter parses OpenClaw's JSONL session transcripts.
 *
 * ```
 * ~/.openclaw/
 *   sessions/＊.jsonl                     ← legacy layout (design doc §4.2.1)
 *   agents/<agent>/sessions/＊.jsonl      ← current layout (OpenClaw 2026.x)
 * ```
 *
 * The adapter auto-detects the active layout at construction time.
 */
export declare class OpenClawAdapter implements RuntimeAdapter {
    readonly id = "openclaw";
    readonly displayName = "OpenClaw";
    readonly version = "1.0.0";
    readonly extendedEventTypes: string[];
    private readonly sessionsDir;
    private readonly recursive;
    private readonly stateFilePath;
    private readonly auditSink?;
    private readonly model?;
    /** sessionId → last byte offset read. Loaded from disk at construction. */
    private offsets;
    constructor(opts?: OpenClawAdapterOptions);
    static defaultSessionsDir(): string;
    private loadPersistedOffsets;
    /** Persist the in-memory offset map to disk (atomic write). */
    flushOffsets(): void;
    /** Test hook: inspect in-memory offsets. */
    getOffset(sessionId: string): number | undefined;
    detect(): Promise<boolean>;
    listNewSessions(since: Date): Promise<SessionRef[]>;
    extractEvents(ref: SessionRef): AsyncIterable<SessionEvent>;
    getEnvFingerprint(): Promise<EnvFingerprint>;
    healthCheck(): Promise<{
        ok: boolean;
        message?: string;
    }>;
    dispose(): Promise<void>;
    /** Walks sessionsDir (1 level deep if `recursive`) collecting `＊.jsonl` files. */
    private discoverJsonlFiles;
    /**
     * Convert one raw OpenClaw JSONL record into 0..N SessionEvents.
     * OpenClaw wraps chat turns in `{type:"message", message:{role, content:[...]}}`
     * where `content` is an array of parts — each `tool_use` / `tool_result` /
     * `text` / `thinking` part becomes its own SessionEvent.
     */
    private toSessionEvents;
    private buildEvent;
    private mapRoleToType;
    private parseTimestamp;
    private stringifySystemEvent;
    private emitAudit;
}
export {};
