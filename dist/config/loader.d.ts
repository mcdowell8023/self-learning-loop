import { type LearnConfig } from './schema.js';
export interface LoaderOptions {
    /** 项目级 config.yaml 路径。默认 `$cwd/learn/config.yaml`（或 `$WORKSPACE/learn/config.yaml`）。 */
    projectConfigPath?: string;
    /** 用户级 config.yaml 路径。默认 `~/.openclaw/learn/config.yaml`。 */
    userConfigPath?: string;
    /** 环境变量快照（默认 `process.env`，测试可注入）。 */
    env?: NodeJS.ProcessEnv;
}
export interface ReloadSuccess {
    ok: true;
    config: LearnConfig;
    /** 发生变更的 top-level 字段（粗粒度审计用）。 */
    changed_sections: string[];
}
export interface ReloadFailure {
    ok: false;
    error_code: 'config_parse_error' | 'config_validation_error' | 'config_read_error';
    message: string;
    details?: unknown;
}
export type ReloadResult = ReloadSuccess | ReloadFailure;
/**
 * `ConfigLoader` 实现双缓冲：
 *  - `current` 指向当前生效配置
 *  - `reload()` 构建 `next` → 校验 → 成功才替换 `current`
 *  - `snapshot()` 返回当前配置的深拷贝（供 Trial 冻结使用）
 */
export declare class ConfigLoader {
    private current;
    private opts;
    private constructor();
    /**
     * 冷启动加载。失败时抛错（没有前配置可回退）。
     */
    static load(opts?: LoaderOptions): ConfigLoader;
    /** 当前生效配置（只读视图 —— 调用方不应 mutate）。 */
    get(): LearnConfig;
    /**
     * 生成配置快照（深拷贝）。
     *
     * Trial 启动时调用，把返回值绑到 trial 上下文，reload 不再影响该 trial。
     * 闭合测试用例 #105。
     */
    snapshot(): LearnConfig;
    /**
     * 双缓冲热更新。
     *
     * 成功：替换 `current`，返回 `{ ok:true, config, changed_sections }`。
     * 失败：保持 `current` 不变，返回错误结果。调用方负责写 audit。
     */
    reload(overrideOpts?: LoaderOptions): ReloadResult;
}
/** 首次加载或返回已存在的 singleton。 */
export declare function loadConfig(opts?: LoaderOptions): LearnConfig;
/** 触发热更新（CLI `openclaw learn config reload` 的实现入口）。 */
export declare function reloadConfig(opts?: LoaderOptions): ReloadResult;
/** 供 Trial 启动时调用，返回当前配置深拷贝。 */
export declare function snapshotConfig(): LearnConfig;
/** 测试专用：重置 singleton。 */
export declare function __resetConfigForTests(): void;
export { LearnConfigSchema } from './schema.js';
export type { LearnConfig } from './schema.js';
