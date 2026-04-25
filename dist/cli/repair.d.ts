export interface RepairRunOptions {
    argv: string[];
    cwd: string;
    stdout: (s: string) => void;
    stderr: (s: string) => void;
}
export interface RepairRunResult {
    exitCode: number;
    total?: number;
    written?: number;
    skipped?: number;
}
export declare function runRepair(opts: RepairRunOptions): Promise<RepairRunResult>;
