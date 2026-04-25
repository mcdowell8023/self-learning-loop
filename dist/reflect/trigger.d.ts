import type { SessionEvent } from './reflection-prompt.js';
export interface TriggerConfig {
    /** 距上次反思的最小间隔（毫秒），默认 6h */
    timeWindowMs: number;
    /** 重复 tool_call 检测窗口（毫秒），默认 6h */
    repeatWindowMs: number;
    /** 重复 tool_call 阈值（同名调用 ≥ N 次视为重复），默认 3 */
    repeatThreshold: number;
    /** 错误关键字（大小写不敏感，contains 匹配） */
    errorKeywords: string[];
    /** 用户纠正关键字（大小写不敏感，contains 匹配） */
    correctionKeywords: string[];
    /** tool_result 失败关键字 */
    toolFailureKeywords: string[];
}
export declare const DEFAULT_TRIGGER_CONFIG: TriggerConfig;
export type TriggerReason = 'error_event' | 'tool_failure' | 'user_correction' | 'repeat_tool_call' | 'time_window' | 'manual';
export interface TriggerDecision {
    shouldReflect: boolean;
    reasons: TriggerReason[];
    /** 每个原因对应的匹配细节（便于审计） */
    details: Array<{
        reason: TriggerReason;
        evidence: string;
    }>;
}
export interface EvaluateInput {
    events: SessionEvent[];
    /** 上次反思时间（ISO 字符串或 Date），首次可省略 */
    lastReflectAt?: string | Date | null;
    /** 当前时间（默认 now），测试注入 */
    now?: Date;
    /** 强制触发（手动/CLI） */
    manual?: boolean;
    config?: Partial<TriggerConfig>;
}
export declare function evaluateTrigger(input: EvaluateInput): TriggerDecision;
