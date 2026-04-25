import type { EnvFingerprint } from '../kernel/types.js';
export interface SessionEvent {
    type: 'user_message' | 'assistant_message' | 'tool_call' | 'tool_result' | 'error' | 'system' | string;
    timestamp: Date | string;
    content: string;
    metadata: Record<string, unknown>;
    contentHash?: string;
    raw?: unknown;
}
export interface BuildPromptParams {
    events: SessionEvent[];
    env: EnvFingerprint;
    /** 既有 Strategy 摘要（"problem_category: recommended_action" 简写） */
    existingStrategies?: string[];
    /** 已知 problem_category 集合（提示 LLM 复用分类） */
    problemCategories?: string[];
    /** 自定义模板（覆盖默认 §5.3.1 骨架） */
    template?: string;
    /** 每个事件 content 的截断长度（防 prompt 过长），默认 500 */
    eventContentTruncate?: number;
    /** 最多纳入多少条事件，默认 50 */
    maxEvents?: number;
}
export declare const DEFAULT_REFLECT_TEMPLATE: string;
export declare function formatEvents(events: SessionEvent[], opts?: {
    truncate?: number;
    maxEvents?: number;
}): string;
export declare function buildReflectPrompt(params: BuildPromptParams): string;
