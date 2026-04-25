export interface ReflectRunOptions {
    argv: string[];
    cwd?: string;
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
}
export interface ReflectResult {
    exitCode: number;
    message?: string;
}
export declare function runReflect(opts: ReflectRunOptions): Promise<ReflectResult>;
