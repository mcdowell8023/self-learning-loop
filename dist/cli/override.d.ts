import { type CandidateStore } from '../store/candidate-store.js';
import type { CandidateState } from '../kernel/types.js';
export interface OverrideRunOptions {
    /** argv tail after `openclaw learn override` (i.e. ["force-graduate","<id>","--reason","..."]). */
    argv: string[];
    /** Where to resolve relative --db / --workspace paths. */
    cwd?: string;
    /** Pre-opened store (mainly for tests). If provided, --db is ignored and the store is NOT closed here. */
    store?: CandidateStore;
    /** Write stdout/stderr here (defaults to process streams). */
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
    /** Clock override for deterministic audit events. */
    now?: () => Date;
    /** UUID override for deterministic audit events. */
    uuid?: () => string;
    /** For force-graduate body write when state === 'validating' (otherwise ignored). */
    defaultBody?: string;
}
export interface OverrideResult {
    exitCode: number;
    action?: 'force_graduate' | 'force_retire' | 'graduation_reverted';
    candidateId?: string;
    fromState?: CandidateState;
    toState?: CandidateState;
    auditPath?: string;
    auditEventId?: string;
    /** Absolute path of the target file if artifact was written (validating → graduated path). */
    targetFile?: string;
    /** True when force-graduate also ran the normal GraduationExecutor artifact write. */
    wroteArtifact?: boolean;
    message?: string;
}
export declare function runOverride(opts: OverrideRunOptions): Promise<OverrideResult>;
type ParsedOk = {
    kind: 'ok';
    command: 'force-graduate' | 'force-retire' | 'revert';
    candidateId: string;
    reason: string;
    dbFlag?: string;
    workspaceFlag?: string;
    actor: string;
};
type ParsedErr = {
    kind: 'error';
    code: number;
    message: string;
};
type ParsedHelp = {
    kind: 'help';
};
type Parsed = ParsedOk | ParsedErr | ParsedHelp;
export declare function parseArgs(argv: string[]): Parsed;
export {};
