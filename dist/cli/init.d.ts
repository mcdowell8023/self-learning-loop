export interface InitRunOptions {
    argv: string[];
    cwd?: string;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
    now?: () => Date;
    uuid?: () => string;
}
export interface InitResult {
    exitCode: number;
    workspace?: string;
    learnDir?: string;
    dbPath?: string;
    configPath?: string;
    auditPath?: string;
    auditEventId?: string;
    forced?: boolean;
    message?: string;
}
interface ParsedInit {
    kind: 'ok' | 'help' | 'error';
    workspaceFlag?: string;
    force?: boolean;
    code?: number;
    message?: string;
}
export declare function parseInitArgs(argv: string[]): ParsedInit;
declare function resolveExamplePath(): string;
export declare function runInit(opts: InitRunOptions): Promise<InitResult>;
export declare const __internal: {
    resolveExamplePath: typeof resolveExamplePath;
};
export {};
