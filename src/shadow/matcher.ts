// src/shadow/matcher.ts
//
// T-P1a-006 · Shadow Runner 匹配引擎（Phase 1a keyword-only）
//
// 实现 v5.0.4 §5.5.4 两层筛选算法：
//   1. 粗筛：problem_category + scope 精确匹配
//      - scope=general       → 匹配所有 session
//      - scope=tool:<name>   → session 含该 tool 的 tool_call
//      - scope=role:<name>   → session 的 agent role 匹配（从 SessionEvent.metadata.role 取）
//      - scope=skill         → session 含 skill 相关事件（metadata.skill 或 content 含 "skill:" 前缀）
//   2. 细筛：trigger_conditions 关键词匹配
//      - 从 trigger_conditions 提取关键词（简单分词 + 停用词过滤）
//      - 对 session content 做 substring 匹配（大小写不敏感）
//      - 命中 ≥ MIN_KEYWORD_HITS（默认 2）个不同关键词 → 匹配
//
// Phase 1a 约束：
//   - 不用 FTS5（SQLite FTS5 索引属于 Phase 1b 优化项）
//   - 不用 LLM（成本爆炸，§5.5.4 明确禁止）
//   - 纯函数：输入确定 → 输出确定
//
// 与 Reflect Generator.trigger 的差异：
//   - Generator.trigger 判断"此 session 是否值得反思"（看错误/工具失败）
//   - 本 Matcher 判断"此候选规则是否适用于此 session"（看 scope + trigger_conditions）

import type { SessionEvent } from '../reflect/reflection-prompt.js';
import type { CandidateScope, Strategy } from '../kernel/types.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface MatcherConfig {
  /** 细筛阶段至少命中几个关键词才算匹配（默认 2） */
  minKeywordHits: number;
  /** 关键词最短长度（过滤 "a/is" 等噪声），默认 3 */
  minKeywordLen: number;
  /** 每条 trigger_conditions 最多抽取多少个关键词（防止爆炸），默认 20 */
  maxKeywords: number;
}

export const DEFAULT_MATCHER_CONFIG: MatcherConfig = {
  minKeywordHits: 2,
  minKeywordLen: 3,
  maxKeywords: 20,
};

// 停用词：中英文混合（Phase 1a 极简版）
const STOPWORDS = new Set<string>([
  // English
  'the', 'and', 'for', 'are', 'but', 'not', 'with', 'you', 'this', 'that',
  'from', 'have', 'has', 'was', 'were', 'will', 'would', 'should', 'could',
  'when', 'what', 'where', 'which', 'while', 'about', 'into', 'over', 'than',
  'then', 'they', 'their', 'them', 'there', 'these', 'those', 'been', 'being',
  'your', 'our', 'ours', 'any', 'all', 'some', 'one', 'two', 'three',
  // 中文：只过滤极少数（中文停用词多在分词器里处理，Phase 1a 先粗放）
  '的', '了', '和', '与', '或', '是', '在', '有', '被', '对', '为', '使',
  '以', '及', '等', '中', '上', '下', '也', '都', '就', '不', '会', '要',
]);

// ---------------------------------------------------------------------------
// 匹配结果
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 关键词抽取
// ---------------------------------------------------------------------------

/**
 * 从 trigger_conditions 抽取关键词。
 * Phase 1a 规则：
 *   - 同时支持 ASCII 单词（按 /\W/ 切分）和中文连续片段（2+ 汉字视为一个词）
 *   - 去重、去停用词、去过短词
 */
export function extractKeywords(
  text: string,
  config: MatcherConfig = DEFAULT_MATCHER_CONFIG,
): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();

  // 1) ASCII 单词：[a-z0-9_]+
  const asciiTokens = lower.match(/[a-z0-9_][a-z0-9_\-]{1,}/g) ?? [];

  // 2) 中文连续片段：[\u4e00-\u9fff]{2,}
  const cjkTokens = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? [];

  const all = [...asciiTokens, ...cjkTokens];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of all) {
    if (tok.length < config.minKeywordLen) continue;
    if (STOPWORDS.has(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= config.maxKeywords) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 粗筛：scope 匹配
// ---------------------------------------------------------------------------

export function coarseMatch(
  scope: CandidateScope,
  events: SessionEvent[],
): { passed: boolean; reason?: string } {
  if (scope === 'general') return { passed: true };

  if (scope === 'skill') {
    const hit = events.some(
      (e) =>
        (typeof e.metadata?.skill === 'string' && e.metadata.skill.length > 0) ||
        e.content.toLowerCase().includes('skill:'),
    );
    return hit
      ? { passed: true }
      : { passed: false, reason: 'scope=skill but no skill event detected' };
  }

  if (scope.startsWith('tool:')) {
    const toolName = scope.slice(5);
    const hit = events.some(
      (e) =>
        e.type === 'tool_call' &&
        (e.metadata?.tool_name === toolName ||
          e.metadata?.name === toolName ||
          // 宽松兜底：content 以 "toolName(" 或 "toolName " 开头
          new RegExp(`^${escapeRegExp(toolName)}\\b`).test(e.content.trim())),
    );
    return hit
      ? { passed: true }
      : { passed: false, reason: `scope=tool:${toolName} but no matching tool_call` };
  }

  if (scope.startsWith('role:')) {
    const roleName = scope.slice(5);
    const hit = events.some(
      (e) =>
        e.metadata?.role === roleName ||
        e.metadata?.agent_role === roleName ||
        e.metadata?.subagent === roleName,
    );
    return hit
      ? { passed: true }
      : { passed: false, reason: `scope=role:${roleName} but no matching role metadata` };
  }

  return { passed: false, reason: `unknown scope: ${scope}` };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 细筛：关键词 substring 匹配
// ---------------------------------------------------------------------------

export function fineMatch(
  keywords: string[],
  events: SessionEvent[],
  config: MatcherConfig = DEFAULT_MATCHER_CONFIG,
): { hits: string[]; total: number } {
  if (keywords.length === 0) return { hits: [], total: 0 };
  const corpus = events.map((e) => e.content.toLowerCase()).join('\n');
  const hits: string[] = [];
  for (const kw of keywords) {
    if (corpus.includes(kw)) hits.push(kw);
  }
  return { hits, total: keywords.length };
}

// ---------------------------------------------------------------------------
// 主入口：matchSession
// ---------------------------------------------------------------------------

/**
 * 判断一个候选策略是否匹配给定 session events。
 * @param strategy 候选策略（只需 scope + trigger_conditions）
 * @param events   会话事件列表（已由 Adapter 标准化）
 * @param config   匹配器配置（可覆盖 minKeywordHits 等）
 */
export function matchSession(
  strategy: Pick<Strategy, 'scope' | 'trigger_conditions'>,
  events: SessionEvent[],
  config: MatcherConfig = DEFAULT_MATCHER_CONFIG,
): MatchResult {
  if (events.length === 0) {
    return {
      matched: false,
      coarsePassed: false,
      matchedKeywords: [],
      totalKeywords: 0,
      reason: 'empty session events',
    };
  }

  // 1) 粗筛
  const coarse = coarseMatch(strategy.scope, events);
  if (!coarse.passed) {
    return {
      matched: false,
      coarsePassed: false,
      matchedKeywords: [],
      totalKeywords: 0,
      reason: coarse.reason,
    };
  }

  // 2) 细筛
  const keywords = extractKeywords(strategy.trigger_conditions, config);
  const { hits, total } = fineMatch(keywords, events, config);
  const matched = hits.length >= config.minKeywordHits;

  return {
    matched,
    coarsePassed: true,
    matchedKeywords: hits,
    totalKeywords: total,
    reason: matched
      ? undefined
      : `keyword hits ${hits.length} < min ${config.minKeywordHits}`,
  };
}
