import type { Candidate, Strategy } from '../kernel/types.js';
export type Dimension = 'metadata' | 'safety' | 'conflict' | 'semantic';
/** 单维度判定结果 */
export interface DimensionResult {
    dimension: Dimension;
    pass: boolean;
    /** 失败时的错误码（不可挽救：SCHEMA_INVALID；可挽救：见各维度） */
    code?: string;
    /** 人类可读的失败原因 */
    reason?: string;
    /** 是否可挽救（可挽救的失败也会转 rejected，但记入 L4 feedback 队列） */
    salvageable?: boolean;
    /** 维度特定的附加信息（如相似度分数、匹配规则等） */
    detail?: Record<string, unknown>;
    /** 耗时（ms） */
    duration_ms?: number;
}
/** 整体审查结果 */
export interface ReviewResult {
    candidate_id: string;
    pass: boolean;
    /** 如果失败，在哪一维短路 */
    failed_at?: Dimension;
    /** 每个维度的结果（按执行顺序；短路时后续维度不会出现） */
    dimensions: DimensionResult[];
    /** 审查者标识（actor/module 名） */
    reviewed_by: string;
    /** 审查完成时间（ISO） */
    reviewed_at: string;
    /** 最终状态：通过→'validating'；失败→'rejected' */
    final_state: 'validating' | 'rejected';
    /** 每次审查的全部 audit log 条目（便于上层落盘） */
    audit_log: AuditLogEntry[];
}
/** 审计日志条目（每维一条；整体一条 summary） */
export interface AuditLogEntry {
    /** ISO 时间戳 */
    timestamp: string;
    candidate_id: string;
    /** 'dimension' 表示单维结果；'summary' 表示整体总结 */
    kind: 'dimension' | 'summary';
    dimension?: Dimension;
    reviewer: string;
    pass: boolean;
    code?: string;
    reason?: string;
    detail?: Record<string, unknown>;
}
/** LLM 辅助判断接口（冲突维度用；Phase 1a 可 mock） */
export interface LlmJudge {
    /**
     * 判断 candidate 是否与既有规则冲突。
     * @returns { conflict: boolean, reason?: string }
     */
    judgeConflict(input: {
        candidate: Candidate;
        existingRuleSnippets: string[];
    }): Promise<{
        conflict: boolean;
        reason?: string;
    }>;
}
/** 用于读取 AGENTS.md / TOOLS.md 等规则文件的提供者（冲突维度用） */
export interface ExistingRulesProvider {
    /** 返回一组规则文本片段（每段通常是一个段落 / 一个规则条目） */
    getRuleSnippets(): Promise<string[]>;
}
/** Strategy Store 查询接口（语义维度去重用；适配 CandidateStore.list） */
export interface StrategyLookup {
    /** 返回当前所有可参与去重比对的 Strategy（通常排除 rejected / retired） */
    listActiveStrategies(): Strategy[];
}
/** Assertion type registry（语义维度可验证性用；Phase 1a 简化） */
export interface AssertionRegistry {
    /** 已注册的可执行 assertion type 集合 */
    hasType(type: string): boolean;
}
export interface ReviewGateConfig {
    /** 语义维度：最小 recommended_action 长度（字符），低于视为质量不足 */
    minActionLength: number;
    /** 语义维度：最小 trigger_conditions 长度 */
    minTriggerLength: number;
    /** 语义维度：相似度阈值（Jaccard n-gram），≥ 该值视为重复 */
    similarityThreshold: number;
    /** 语义维度：n-gram 大小（字符级） */
    ngramSize: number;
    /** 安全维度：关键字黑名单（recommended_action / trigger_conditions 中出现即命中） */
    bannedKeywords: string[];
    /** 安全维度：敏感路径前缀 */
    sensitivePaths: string[];
    /** 安全维度：硬编码密钥正则（匹配即命中） */
    secretPatterns: RegExp[];
    /** 冲突维度：AGENTS/TOOLS keyword 命中阈值（与 candidate 共享 token 数 ≥ 该值触发 LLM 辅助判断） */
    conflictKeywordThreshold: number;
    /** 冲突维度：是否启用 LLM 辅助判断 */
    useLlmForConflict: boolean;
    /** 元信息维度：必填字段清单 */
    requiredFields: Array<'scope' | 'problem_category' | 'trigger_conditions' | 'recommended_action'>;
    /** 允许的 scope 前缀（`tool:` / `role:` / `general` / `skill`） */
    allowedScopePatterns: RegExp[];
    /** 是否要求每个 instance 至少有一条已注册的 assertion（D4 可验证性） */
    requireVerifiableAssertion: boolean;
}
export declare const DEFAULT_REVIEW_CONFIG: ReviewGateConfig;
