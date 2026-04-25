import type { Candidate, CandidateScope, EnvFingerprint } from '../kernel/types.js';
import type { CandidateStore } from '../store/candidate-store.js';
import { type GraduationRecord, type L1AssertionSummary, type L2MetricsDelta, type L3JudgeSummary, type L4FeedbackSummary } from './graduation-record.js';
export interface GraduationExecutorOptions {
    /** Root workspace directory. AGENTS.md / TOOLS.md live directly under here. */
    workspaceDir: string;
    /** Directory for graduated content blobs. Default: <workspaceDir>/learn/graduated */
    graduatedDir?: string;
    /** Directory for audit records. Default: <workspaceDir>/learn/audit */
    auditDir?: string;
    /** Candidate store, used to transition state after a successful graduate. */
    store?: CandidateStore;
    /** Optional override of AGENTS.md filename (for tests). */
    agentsFileName?: string;
    /** When true, a missing rollback checkpoint aborts graduation (test #94). */
    requireCheckpoint?: boolean;
    /** Default env fingerprint embedded in graduation_record if caller omits one. */
    defaultEnvFingerprint?: EnvFingerprint;
}
export interface GraduateInput {
    /** The candidate being graduated. */
    candidate: Candidate;
    /** Body (markdown) to inject between marker block. Typically pre-rendered. */
    body: string;
    /** Instance id that produced the graduated artifact. Defaults to first instance. */
    instanceId?: string;
    /** Shadow data attached to the graduation_record. */
    shadow: {
        trial_count: number;
        l1: L1AssertionSummary;
        l2: L2MetricsDelta;
        l3: L3JudgeSummary;
        l4?: L4FeedbackSummary;
    };
    env_fingerprint?: EnvFingerprint;
    graduated_by?: string;
    /** Optional rollback checkpoint (e.g. pre-graduation git commit hash). */
    rollbackCheckpoint?: {
        git_commit?: string | null;
    };
    /** When true, skip the CandidateStore state transition (e.g. force-graduate already did it). */
    skipStateTransition?: boolean;
}
export interface GraduateResult {
    content_hash: string;
    target_file: string;
    record_path: string;
    body_path: string;
    record: GraduationRecord;
    injected: boolean;
    transitioned: boolean;
}
export declare class GraduationScopeError extends Error {
    readonly scope: CandidateScope;
    constructor(scope: CandidateScope);
}
export declare class GraduationCheckpointMissingError extends Error {
    readonly candidateId: string;
    constructor(candidateId: string);
}
export declare class GraduationStateError extends Error {
    readonly candidateId: string;
    readonly state: string;
    constructor(candidateId: string, state: string);
}
export declare class GraduationExecutor {
    private readonly workspaceDir;
    private readonly graduatedDir;
    private readonly auditDir;
    private readonly graduationsDir;
    private readonly store;
    private readonly agentsPath;
    private readonly requireCheckpoint;
    private readonly defaultEnv;
    constructor(opts: GraduationExecutorOptions);
    /** Resolve the routed target file for a given scope. P1a: only `general` allowed. */
    resolveTarget(scope: CandidateScope): string;
    /** Main entry: graduate a candidate. */
    graduate(input: GraduateInput): GraduateResult;
    /**
     * Rollback: remove the marker block from the routed target.
     * Does NOT delete the graduated/<hash>.md content blob (content-addressable,
     * immutable) nor the graduation_record (audit trail — retain for history).
     *
     * Returns `{ removed: true }` if a block existed, else `{ removed: false }`.
     */
    rollback(scope: CandidateScope, contentHash: string): {
        removed: boolean;
    };
    /**
     * Load a previously-persisted graduation_record by content hash, or null.
     */
    readRecord(contentHash: string): GraduationRecord | null;
}
export { buildGraduationRecord, serializeGraduationRecord } from './graduation-record.js';
export type { GraduationRecord } from './graduation-record.js';
