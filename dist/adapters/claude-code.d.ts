import type { EnvFingerprint, SessionEvent, SessionRef } from '../kernel/schemas/session.js';
import { type AuditSink, type RuntimeAdapter } from './base.js';
export interface ClaudeCodeAdapterOptions {
    /** Override the projects root directory. If omitted, auto-detected via fallback chain. */
    projectsRoot?: string;
    /** Optional audit sink for non-fatal warnings. */
    auditSink?: AuditSink;
}
export interface DryRunResult {
    success: boolean;
    detectedPath?: string;
    triedPaths: string[];
    hint: string;
}
/**
 * Probe the filesystem for ClaudeCode project directories with detailed diagnostics.
 * Use when detect() returns false to guide the user.
 */
export declare function detectClaudeCodeWithDryRun(overridePaths?: string[]): Promise<DryRunResult>;
export declare class ClaudeCodeAdapter implements RuntimeAdapter {
    readonly id = "claude-code";
    readonly displayName = "Claude Code";
    readonly version = "0.1.0";
    private projectsRoot;
    private readonly auditSink?;
    constructor(options?: ClaudeCodeAdapterOptions);
    detect(): Promise<boolean>;
    listNewSessions(since: Date): Promise<SessionRef[]>;
    /**
     * ⚠️ 待实测：jsonl 字段名假设 role/content/timestamp，实际可能不同。
     * Parses ClaudeCode session jsonl into normalized SessionEvent stream.
     */
    extractEvents(ref: SessionRef): AsyncIterable<SessionEvent>;
    getEnvFingerprint(): Promise<EnvFingerprint>;
    healthCheck(): Promise<{
        ok: boolean;
        message?: string;
    }>;
    dispose(): Promise<void>;
}
