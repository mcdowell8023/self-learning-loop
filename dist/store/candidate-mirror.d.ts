import type { Candidate } from '../kernel/types.js';
export declare function mirrorFileName(candidate: Candidate): string;
export declare function mirrorPath(candidatesDir: string, candidate: Candidate): string;
export declare function renderMirror(candidate: Candidate): string;
export declare function writeMirror(candidatesDir: string, candidate: Candidate): string;
export declare function isMirrorCurrent(candidatesDir: string, candidate: Candidate): boolean;
export interface RepairResult {
    total: number;
    written: number;
    skipped: number;
    details: Array<{
        id: string;
        action: 'written' | 'skipped';
    }>;
}
export declare function repairMirrors(candidatesDir: string, candidates: Candidate[], opts?: {
    dryRun?: boolean;
}): RepairResult;
