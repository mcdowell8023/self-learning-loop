#!/usr/bin/env node
export interface LearnRunOptions {
    argv: string[];
    cwd?: string;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
}
export interface LearnResult {
    exitCode: number;
    command?: string;
    subResult?: unknown;
    message?: string;
}
export declare function runLearn(opts: LearnRunOptions): Promise<LearnResult>;
