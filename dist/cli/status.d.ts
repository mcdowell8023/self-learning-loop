import { CandidateStore } from '../store/candidate-store.js';
export interface StatusRunOptions {
    argv: string[];
    cwd?: string;
    store?: CandidateStore;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
}
export interface StatusResult {
    exitCode: number;
    matched?: number;
    candidateId?: string;
    message?: string;
}
interface Parsed {
    kind: 'ok' | 'help' | 'error';
    candidateId?: string;
    scopeFilter?: string[];
    stateFilter?: string[];
    dbFlag?: string;
    workspaceFlag?: string;
    code?: number;
    message?: string;
}
export declare function parseStatusArgs(argv: string[]): Parsed;
export declare function runStatus(opts: StatusRunOptions): Promise<StatusResult>;
export {};
