import { type CandidateStore } from '../store/candidate-store.js';
import type { EnvFingerprint } from '../kernel/types.js';
import type { SessionEvent } from '../reflect/reflection-prompt.js';
export declare const TEST_ENV: EnvFingerprint;
export interface E2EContext {
    tmpDir: string;
    workspaceDir: string;
    store: CandidateStore;
    dbPath: string;
    agentsPath: string;
    auditDir: string;
}
export declare function setupE2E(): E2EContext;
export declare function teardownE2E(ctx: E2EContext): void;
export declare function getAgentsMtime(ctx: E2EContext): number;
export declare function readAgents(ctx: E2EContext): string;
export declare function loadFixture<T>(name: string): T;
export declare function makeEvents(raw: Array<Record<string, unknown>>): SessionEvent[];
/** Read JSONL audit file and parse all lines. */
export declare function readAuditJsonl(path: string): unknown[];
