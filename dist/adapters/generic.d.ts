import type { EnvFingerprint, SessionEvent, SessionRef } from '../kernel/schemas/session.js';
import { type RuntimeAdapter } from './base.js';
export declare class GenericAdapter implements RuntimeAdapter {
    readonly id: string;
    readonly displayName: string;
    readonly version = "1.0.0";
    private readonly mapping;
    private readonly resolvedPaths;
    constructor(yamlMappingPath: string);
    detect(): Promise<boolean>;
    listNewSessions(since: Date): Promise<SessionRef[]>;
    extractEvents(ref: SessionRef): AsyncIterable<SessionEvent>;
    getEnvFingerprint(): Promise<EnvFingerprint>;
    healthCheck(): Promise<{
        ok: boolean;
        message?: string;
    }>;
    dispose(): Promise<void>;
}
