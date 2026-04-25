export interface ConfigShowRunOptions {
    argv: string[];
    cwd?: string;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
}
export interface ConfigShowResult {
    exitCode: number;
    message?: string;
}
export declare function runConfigShow(opts: ConfigShowRunOptions): Promise<ConfigShowResult>;
