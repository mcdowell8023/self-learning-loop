import type { EnvFingerprint, Instance, Strategy } from '../kernel/types.js';
import type { CandidateStore } from '../store/candidate-store.js';
import type { LLMClient, LLMCompleteOptions } from './llm-client.js';
import { type SessionEvent } from './reflection-prompt.js';
import { type TriggerConfig, type TriggerDecision } from './trigger.js';
export interface GeneratorConfig {
    /** LLM 调用选项 */
    llmOptions?: LLMCompleteOptions;
    /** 最低置信度阈值，低于则丢弃（默认 0.3，对齐 §5.3.3） */
    minConfidence: number;
    /** 每次反思最多产出数（默认 3，对齐 §5.3.3） */
    maxCandidatesPerReflect: number;
    /** 触发器配置覆盖 */
    triggerConfig?: Partial<TriggerConfig>;
    /** Prompt 模板（覆盖默认） */
    promptTemplate?: string;
    /** 事件截断 / 最大事件数 */
    eventContentTruncate?: number;
    maxEvents?: number;
    /** 允许的 scope 正则集合（默认与 Review Gate 一致） */
    allowedScopePatterns: RegExp[];
}
export declare const DEFAULT_GENERATOR_CONFIG: GeneratorConfig;
export interface ReflectInput {
    events: SessionEvent[];
    env: EnvFingerprint;
    /** 来源 session（用于 Instance.source_sessions） */
    sessionId: string;
    /** 上次反思时间（触发器判断用） */
    lastReflectAt?: string | Date | null;
    /** 既有 Strategy 摘要（Prompt 去重提示） */
    existingStrategies?: string[];
    /** 已知 problem_category（Prompt 复用分类） */
    problemCategories?: string[];
    /** 强制触发（跳过触发器） */
    manual?: boolean;
    /** 当前时间（测试注入） */
    now?: Date;
}
export interface GeneratedCandidate {
    strategy: Strategy;
    instance: Instance;
    confidence: number;
    rationale?: string;
    raw: RawCandidateJSON;
}
export interface ReflectResult {
    /** 是否触发了反思（false = 触发器未命中或 manual=false 且无证据） */
    triggered: boolean;
    triggerDecision: TriggerDecision;
    /** LLM 返回的原始文本（便于审计） */
    rawResponse?: string;
    /** 通过阈值 + schema 校验的候选 */
    candidates: GeneratedCandidate[];
    /** 被丢弃的项及原因 */
    dropped: Array<{
        reason: string;
        raw: unknown;
    }>;
    /** 实际写入 Store 的数量 */
    persistedCount: number;
    /** 错误信息（LLM/解析失败时） */
    error?: string;
}
interface RawAssertionJSON {
    type?: string;
    description?: string;
    command?: string;
    expected_exit_code?: number;
    [k: string]: unknown;
}
interface RawCandidateJSON {
    problem_category?: string;
    trigger_conditions?: string;
    recommended_action?: string;
    scope?: string;
    tags?: string[];
    diff_summary?: string;
    files_touched?: string[];
    assertions?: RawAssertionJSON[];
    confidence?: number;
    rationale?: string;
    [k: string]: unknown;
}
export declare class CandidateGenerator {
    private readonly llm;
    private readonly store;
    private readonly config;
    constructor(llm: LLMClient, store: CandidateStore, config?: Partial<GeneratorConfig>);
    /**
     * 主入口：执行一次反思。
     *
     * 返回 ReflectResult；不抛错（除非调用方误用，如传 null events）。
     */
    reflect(input: ReflectInput): Promise<ReflectResult>;
    private parseResponse;
    private validate;
    private buildStrategy;
    private buildInstance;
}
export {};
