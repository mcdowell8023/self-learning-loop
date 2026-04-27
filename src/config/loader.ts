/**
 * T-P1a-010 — Config Loader v1.
 *
 * 职责（DoD §14.1 #18 / 设计 §11）：
 *  - 加载优先级：env > project (learn/config.yaml) > user (~/.openclaw/learn/config.yaml) > 默认值
 *  - 双缓冲热更新：新配置校验失败 → 保持旧配置 + 返回错误码 + audit 事件（由调用方消费）
 *  - Trial 配置快照：`snapshotConfig()` 暴露冻结副本，reload 不影响 in-flight trial
 *  - CLI reload 是 `reloadConfig()` 的薄壳（T-P1a-011 接线）
 *
 * 不在本 ticket 范围：SIGHUP、file watch（P1b/P2）。
 *
 * @module
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { ZodError } from 'zod';
import { LearnConfigSchema, type LearnConfig } from './schema.js';

// ─── Types ──────────────────────────────────────────

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
 * Interpolate `${VAR}` patterns in a string with environment variable values.
 */
export function interpolateEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => env[name] ?? '');
}

/**
 * Recursively interpolate env vars in all string values of an object.
 */
function interpolatePaths(obj: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof obj === 'string') return interpolateEnvVars(obj, env);
  if (Array.isArray(obj)) return obj.map(v => interpolatePaths(v, env));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = interpolatePaths(v, env);
    }
    return out;
  }
  return obj;
}

// ─── Constants ──────────────────────────────────────

const ENV_PREFIX = 'OPENCLAW_LEARN_';

// ─── Helpers ────────────────────────────────────────

function defaultProjectPath(env: NodeJS.ProcessEnv): string {
  const ws = env.WORKSPACE;
  const base = ws && ws.length > 0 ? ws : process.cwd();
  return resolve(base, 'learn', 'config.yaml');
}

function defaultUserPath(): string {
  return resolve(homedir(), '.openclaw', 'workspace', 'learn', 'config.yaml');
}

function safeReadYaml(path: string): {
  ok: true;
  data: unknown;
} | {
  ok: false;
  error_code: 'config_parse_error' | 'config_read_error';
  message: string;
} {
  try {
    const raw = readFileSync(path, 'utf8');
    try {
      const data = YAML.parse(raw);
      return { ok: true, data: data ?? {} };
    } catch (err) {
      return {
        ok: false,
        error_code: 'config_parse_error',
        message: `YAML parse failed at ${path}: ${(err as Error).message}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error_code: 'config_read_error',
      message: `Read failed at ${path}: ${(err as Error).message}`,
    };
  }
}

/** 深度合并：后者覆盖前者；数组直接替换。 */
function deepMerge(base: unknown, over: unknown): unknown {
  if (Array.isArray(over)) return over;
  if (
    over && typeof over === 'object' &&
    base && typeof base === 'object' && !Array.isArray(base)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v);
    }
    return out;
  }
  return over === undefined ? base : over;
}

/**
 * 把 `OPENCLAW_LEARN_SHADOW_MIN_TRIALS=5` 这种 env 映射为
 * `{ shadow: { min_trials: 5 } }` 部分对象。
 *
 * 规则（§11.1）：
 *  - 前缀 `OPENCLAW_LEARN_` 去掉
 *  - 按 `_` 切段，全部小写作为嵌套 key
 *  - 值尝试解析：true/false → boolean；纯数字 → number；JSON 数组/对象 → parse；否则字符串
 *
 * 边界：schema 字段名自身含下划线（如 `min_trials`）时，env 会把下划线当分隔符，
 * 因此 env 映射在深度为 N 的段数 = schema 字段下划线数之和 + 嵌套层数。
 * 我们在合并时允许「扁平尝试」——按 schema 已知字段集智能聚合，避免过度切分。
 */
function parseEnvValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return raw;
}

/**
 * 把形如 `SHADOW_MIN_TRIALS` 的 env 路径解析成 `['shadow', 'min_trials']`。
 *
 * 策略：按段小写后，贪心地与 schema 已知键合并。因为我们只支持有限的 top-level
 * 字段，这里硬编码已知多词字段表，遇到匹配就合段。
 */
const KNOWN_COMPOUND_KEYS: readonly string[] = [
  'min_trials', 'max_trials', 'max_daily',
  'observation_mode', 'sample_bias_protection',
  'min_unique_sessions', 'max_same_session_ratio',
  'confidence_threshold', 'l3_enabled', 'l3_model',
  'timeout_ms', 'timeout_max_ms',
  'auto_decide_enabled', 'significance_thresholds',
  'turns_delta_pct', 'turns_delta_abs', 'errors_delta',
  'token_delta_pct', 'completion_rate_delta_pct',
  'post_decision_validation_days', 'auto_rerun_max',
  'max_candidates_per_session', 'fallback_model', 'prompt_path',
  'min_turns', 'min_tool_calls', 'exclude_labels',
  'window_ms', 'prefer_richer_env', 'trial_dedup_key',
  'scope_routes', 'rollback_keep', 'skill_packaging', 'output_dir',
  'credit_limit', 'auto_publish', 'sensitive_patterns', 'a2a_enabled',
  'risk_escalation_rules',
  'base_dir', 'audit_dir', 'candidates_dir', 'clusters_dir', 'max_jsonl_size_kb',
  'agents_root', 'projects_root', 'legacy_session_dir', 'session_dir',
  'skills_dir', 'data_dir', 'memory_dir',
  'claude_code',
];

function splitEnvPath(suffix: string): string[] {
  const segs = suffix.toLowerCase().split('_').filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < segs.length) {
    // Try greedy merge: longest compound key first (up to 4 segments).
    let matched = false;
    for (let take = Math.min(4, segs.length - i); take >= 2; take--) {
      const combo = segs.slice(i, i + take).join('_');
      if (KNOWN_COMPOUND_KEYS.includes(combo)) {
        out.push(combo);
        i += take;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push(segs[i]!);
      i++;
    }
  }
  return out;
}

function setDeep(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (typeof cur[key] !== 'object' || cur[key] === null || Array.isArray(cur[key])) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

function extractEnvOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (!k.startsWith(ENV_PREFIX)) continue;
    const suffix = k.slice(ENV_PREFIX.length);
    if (!suffix) continue;
    const path = splitEnvPath(suffix);
    setDeep(out, path, parseEnvValue(v));
  }
  return out;
}

// ─── Core API ───────────────────────────────────────

/**
 * Compute per-field source tracking.
 * Flattens config to dot-paths and determines origin.
 */
function computeFieldSources(
  config: LearnConfig,
  userRaw: unknown,
  projectRaw: unknown,
  envOverrides: Record<string, unknown>,
): Map<string, 'default' | 'config-file' | 'env-var'> {
  const sources = new Map<string, 'default' | 'config-file' | 'env-var'>();

  function flatten(obj: unknown, prefix: string = ''): string[] {
    const paths: string[] = [];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          paths.push(...flatten(v, p));
        } else {
          paths.push(p);
        }
      }
    }
    return paths;
  }

  function hasPath(obj: unknown, path: string): boolean {
    const parts = path.split('.');
    let cur: unknown = obj;
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object') return false;
      if (!(p in (cur as Record<string, unknown>))) return false;
      cur = (cur as Record<string, unknown>)[p];
    }
    return true;
  }

  const allPaths = flatten(config);
  for (const path of allPaths) {
    if (hasPath(envOverrides, path)) {
      sources.set(path, 'env-var');
    } else if (hasPath(projectRaw, path) || hasPath(userRaw, path)) {
      sources.set(path, 'config-file');
    } else {
      sources.set(path, 'default');
    }
  }
  return sources;
}

function buildMerged(opts: Required<LoaderOptions>): {
  ok: true;
  raw: unknown;
  sources: string[];
  userRaw: unknown;
  projectRaw: unknown;
  envOverrides: Record<string, unknown>;
} | ReloadFailure {
  const sources: string[] = ['defaults'];
  let merged: unknown = {};
  let userRaw: unknown = {};
  let projectRaw: unknown = {};

  // user level
  if (existsSync(opts.userConfigPath)) {
    const r = safeReadYaml(opts.userConfigPath);
    if (!r.ok) return { ok: false, error_code: r.error_code, message: r.message };
    userRaw = r.data;
    merged = deepMerge(merged, r.data);
    sources.push(`user:${opts.userConfigPath}`);
  }

  // project level
  if (existsSync(opts.projectConfigPath)) {
    const r = safeReadYaml(opts.projectConfigPath);
    if (!r.ok) return { ok: false, error_code: r.error_code, message: r.message };
    projectRaw = r.data;
    merged = deepMerge(merged, r.data);
    sources.push(`project:${opts.projectConfigPath}`);
  }

  // env overrides (highest priority)
  const envOverrides = extractEnvOverrides(opts.env);
  if (Object.keys(envOverrides).length > 0) {
    merged = deepMerge(merged, envOverrides);
    sources.push('env');
  }

  return { ok: true, raw: merged, sources, userRaw, projectRaw, envOverrides };
}

function normalizeOpts(opts: LoaderOptions): Required<LoaderOptions> {
  const env = opts.env ?? process.env;
  return {
    projectConfigPath: opts.projectConfigPath ?? defaultProjectPath(env),
    userConfigPath: opts.userConfigPath ?? defaultUserPath(),
    env,
  };
}

function validate(raw: unknown, env: NodeJS.ProcessEnv = process.env): { ok: true; config: LearnConfig } | ReloadFailure {
  try {
    const parsed = LearnConfigSchema.parse(raw);
    // Interpolate env vars in paths
    parsed.paths = interpolatePaths(parsed.paths, env) as LearnConfig['paths'];
    return { ok: true, config: parsed };
  } catch (err) {
    const zerr = err instanceof ZodError ? err : null;
    return {
      ok: false,
      error_code: 'config_validation_error',
      message: zerr ? zerr.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message,
      details: zerr?.issues,
    };
  }
}

function diffTopLevel(a: LearnConfig, b: LearnConfig): string[] {
  const changed: string[] = [];
  for (const k of Object.keys(a) as (keyof LearnConfig)[]) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k as string);
  }
  return changed;
}

// ─── Loader (double-buffered singleton wrapper) ─────

/**
 * `ConfigLoader` 实现双缓冲：
 *  - `current` 指向当前生效配置
 *  - `reload()` 构建 `next` → 校验 → 成功才替换 `current`
 *  - `snapshot()` 返回当前配置的深拷贝（供 Trial 冻结使用）
 */
export class ConfigLoader {
  private current: LearnConfig;
  private opts: Required<LoaderOptions>;
  /** Tracks which source each top-level field was last set by. */
  private _sources: Map<string, 'default' | 'config-file' | 'env-var'> = new Map();

  private constructor(initial: LearnConfig, opts: Required<LoaderOptions>, sources?: Map<string, 'default' | 'config-file' | 'env-var'>) {
    this.current = initial;
    this.opts = opts;
    if (sources) this._sources = sources;
  }

  /**
   * 冷启动加载。失败时抛错（没有前配置可回退）。
   */
  static load(opts: LoaderOptions = {}): ConfigLoader {
    const full = normalizeOpts(opts);
    const merged = buildMerged(full);
    if (!merged.ok) {
      throw new Error(`[config] initial load failed: ${merged.message}`);
    }
    const validated = validate(merged.raw, full.env);
    if (!validated.ok) {
      throw new Error(`[config] initial validation failed: ${validated.message}`);
    }
    const fieldSources = computeFieldSources(validated.config, merged.userRaw, merged.projectRaw, merged.envOverrides);
    return new ConfigLoader(validated.config, full, fieldSources);
  }

  /** Get per-field source map. */
    getSources(): Map<string, 'default' | 'config-file' | 'env-var'> {
    return this._sources;
  }

  /** 当前生效配置（只读视图 —— 调用方不应 mutate）。 */
  get(): LearnConfig {
    return this.current;
  }

  /**
   * 生成配置快照（深拷贝）。
   *
   * Trial 启动时调用，把返回值绑到 trial 上下文，reload 不再影响该 trial。
   * 闭合测试用例 #105。
   */
  snapshot(): LearnConfig {
    return structuredClone(this.current);
  }

  /**
   * 双缓冲热更新。
   *
   * 成功：替换 `current`，返回 `{ ok:true, config, changed_sections }`。
   * 失败：保持 `current` 不变，返回错误结果。调用方负责写 audit。
   */
  reload(overrideOpts?: LoaderOptions): ReloadResult {
    const next = overrideOpts ? normalizeOpts(overrideOpts) : this.opts;
    const merged = buildMerged(next);
    if (!merged.ok) return merged;
    const validated = validate(merged.raw, next.env);
    if (!validated.ok) return validated;
    const prev = this.current;
    this.current = validated.config;
    this.opts = next;
    this._sources = computeFieldSources(validated.config, merged.userRaw, merged.projectRaw, merged.envOverrides);
    return {
      ok: true,
      config: validated.config,
      changed_sections: diffTopLevel(prev, validated.config),
    };
  }
}

// ─── Module-level convenience API ───────────────────

let _singleton: ConfigLoader | null = null;

/** 首次加载或返回已存在的 singleton。 */
export function loadConfig(opts: LoaderOptions = {}): LearnConfig {
  if (!_singleton) _singleton = ConfigLoader.load(opts);
  return _singleton.get();
}

/** Get field source map (must call loadConfig first). */
export function getConfigSources(): Map<string, 'default' | 'config-file' | 'env-var'> {
  if (!_singleton) throw new Error('[config] not loaded; call loadConfig() first');
  return _singleton.getSources();
}

/** 触发热更新（CLI `openclaw learn config reload` 的实现入口）。 */
export function reloadConfig(opts?: LoaderOptions): ReloadResult {
  if (!_singleton) {
    try {
      _singleton = ConfigLoader.load(opts ?? {});
      return { ok: true, config: _singleton.get(), changed_sections: [] };
    } catch (err) {
      return { ok: false, error_code: 'config_read_error', message: (err as Error).message };
    }
  }
  return _singleton.reload(opts);
}

/** 供 Trial 启动时调用，返回当前配置深拷贝。 */
export function snapshotConfig(): LearnConfig {
  if (!_singleton) throw new Error('[config] not loaded; call loadConfig() first');
  return _singleton.snapshot();
}

/** 测试专用：重置 singleton。 */
export function __resetConfigForTests(): void {
  _singleton = null;
}

// Re-exports for callers importing from this module root.
export { LearnConfigSchema } from './schema.js';
export type { LearnConfig } from './schema.js';
