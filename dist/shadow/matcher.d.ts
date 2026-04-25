import type { SessionEvent } from '../reflect/reflection-prompt.js';
import type { CandidateScope, Strategy } from '../kernel/types.js';
export interface MatcherConfig {
    /** 细筛阶段至少命中几个关键词才算匹配（默认 2） */
    minKeywordHits: number;
    /** 关键词最短长度（过滤 "a/is" 等噪声），默认 3 */
    minKeywordLen: number;
    /** 每条 trigger_conditions 最多抽取多少个关键词（防止爆炸），默认 20 */
    maxKeywords: number;
}
export declare const DEFAULT_MATCHER_CONFIG: MatcherConfig;
export interface MatchResult {
    matched: boolean;
    /** 粗筛通过？ */
    coarsePassed: boolean;
    /** 细筛命中的关键词列表（大小写归一） */
    matchedKeywords: string[];
    /** 从 trigger_conditions 抽取的关键词总数 */
    totalKeywords: number;
    /** 未匹配原因（debug 用） */
    reason?: string;
}
/**
 * 从 trigger_conditions 抽取关键词。
 * Phase 1a 规则：
 *   - 同时支持 ASCII 单词（按 /\W/ 切分）和中文连续片段（2+ 汉字视为一个词）
 *   - 去重、去停用词、去过短词
 */
export declare function extractKeywords(text: string, config?: MatcherConfig): string[];
export declare function coarseMatch(scope: CandidateScope, events: SessionEvent[]): {
    passed: boolean;
    reason?: string;
};
export declare function fineMatch(keywords: string[], events: SessionEvent[], config?: MatcherConfig): {
    hits: string[];
    total: number;
};
/**
 * 判断一个候选策略是否匹配给定 session events。
 * @param strategy 候选策略（只需 scope + trigger_conditions）
 * @param events   会话事件列表（已由 Adapter 标准化）
 * @param config   匹配器配置（可覆盖 minKeywordHits 等）
 */
export declare function matchSession(strategy: Pick<Strategy, 'scope' | 'trigger_conditions'>, events: SessionEvent[], config?: MatcherConfig): MatchResult;
