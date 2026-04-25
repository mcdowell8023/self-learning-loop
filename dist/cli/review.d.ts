import { type CandidateStore } from '../store/candidate-store.js';
export interface ReviewRunOptions {
    argv: string[];
    cwd?: string;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
    store?: CandidateStore;
}
export interface ReviewResult {
    exitCode: number;
    message?: string;
}
export declare function runReview(opts: ReviewRunOptions): Promise<ReviewResult>;
