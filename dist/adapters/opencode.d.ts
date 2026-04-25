import type { EnvFingerprint, SessionEvent, SessionRef } from '../kernel/schemas/session.js';
import { type RuntimeAdapter } from './base.js';
export interface OpencodeAdapterOptions {
    /** Override DB path (for testing). */
    dbPath?: string;
    /** ACP protocol toggle — default false (SQLite-only). */
    acpEnabled?: boolean;
    /** ACP port (only used when acpEnabled=true). */
    acpPort?: number;
}
/** §4.4.2 contentHash: SHA256(type + ":" + content).slice(0,32) */
export declare function computeContentHash(type: string, content: string): string;
export declare class OpencodeAdapter implements RuntimeAdapter {
    private readonly options;
    readonly id = "opencode";
    readonly displayName = "Opencode";
    readonly version = "2.0.0";
    private db?;
    private readonly dbPath;
    private readonly acpEnabled;
    constructor(options?: OpencodeAdapterOptions);
    detect(): Promise<boolean>;
    listNewSessions(since: Date): Promise<SessionRef[]>;
    extractEvents(ref: SessionRef): AsyncIterable<SessionEvent>;
    getEnvFingerprint(): Promise<EnvFingerprint>;
    healthCheck(): Promise<{
        ok: boolean;
        message?: string;
    }>;
    dispose(): Promise<void>;
    private getDb;
    private partToEvent;
}
