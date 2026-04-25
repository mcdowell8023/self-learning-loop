export interface AuditRunOptions {
    argv: string[];
    cwd?: string;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
}
export interface AuditResult {
    exitCode: number;
    message?: string;
}
export declare function runAudit(opts: AuditRunOptions): Promise<AuditResult>;
