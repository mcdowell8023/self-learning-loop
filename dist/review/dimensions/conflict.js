// src/review/dimensions/conflict.ts
//
// 冲突维度（映射 v5.0.3 §5.4 D3 唯一性 + 与现有规则冲突）
//
// 校验点：
//   1. Keyword 匹配：candidate 的 recommended_action / trigger_conditions token
//      与 AGENTS.md / TOOLS.md 规则片段共享 token 数超阈值 → 疑似冲突
//   2. LLM 辅助判断（mockable）：把 candidate + 疑似冲突的片段送 LLM 判定
//   3. 若无 ExistingRulesProvider 或未启用 LLM → 仅跳过 LLM 辅助，keyword 命中降级为告警不 fail
//
// 失败 → 可挽救（可通过 L4 feedback 修改 candidate 措辞或合并到现有规则）
import { wordTokens } from '../util/similarity.js';
function countSharedTokens(a, b) {
    let n = 0;
    for (const x of a)
        if (b.has(x))
            n++;
    return n;
}
export async function reviewConflict(candidate, deps) {
    const started = Date.now();
    const cfg = deps.config;
    // 无 rulesProvider → 该维度直接 pass（视作"无既有规则可参与冲突比对"）
    if (!deps.rulesProvider) {
        return {
            dimension: 'conflict',
            pass: true,
            detail: { skipped: 'no_rules_provider' },
            duration_ms: Date.now() - started,
        };
    }
    const snippets = await deps.rulesProvider.getRuleSnippets();
    if (snippets.length === 0) {
        return {
            dimension: 'conflict',
            pass: true,
            detail: { skipped: 'empty_rules' },
            duration_ms: Date.now() - started,
        };
    }
    const candidateText = [
        candidate.strategy.recommended_action,
        candidate.strategy.trigger_conditions,
        candidate.strategy.problem_category,
    ].join(' ');
    const candTokens = wordTokens(candidateText);
    // 1) Keyword 命中：筛出共享 token 数 ≥ 阈值的片段
    const suspicious = [];
    for (const sn of snippets) {
        const t = wordTokens(sn);
        const shared = countSharedTokens(candTokens, t);
        if (shared >= cfg.conflictKeywordThreshold) {
            suspicious.push({ snippet: sn, sharedCount: shared });
        }
    }
    if (suspicious.length === 0) {
        return {
            dimension: 'conflict',
            pass: true,
            detail: { checkedSnippets: snippets.length, suspicious: 0 },
            duration_ms: Date.now() - started,
        };
    }
    // 排序取 top 5 送 LLM
    suspicious.sort((a, b) => b.sharedCount - a.sharedCount);
    const topSuspicious = suspicious.slice(0, 5);
    // 2) LLM 辅助判断
    if (!cfg.useLlmForConflict || !deps.llm) {
        // 仅 keyword 命中不足以判冲突 → pass，但记 warning
        return {
            dimension: 'conflict',
            pass: true,
            detail: {
                suspicious: topSuspicious,
                note: 'keyword_match_without_llm_judge',
            },
            duration_ms: Date.now() - started,
        };
    }
    const judgment = await deps.llm.judgeConflict({
        candidate,
        existingRuleSnippets: topSuspicious.map((s) => s.snippet),
    });
    const pass = !judgment.conflict;
    return {
        dimension: 'conflict',
        pass,
        code: pass ? undefined : 'RULE_CONFLICT',
        reason: pass ? undefined : judgment.reason ?? 'conflict with existing rules',
        salvageable: !pass, // 冲突可挽救：修改措辞或合并
        detail: {
            suspiciousCount: suspicious.length,
            topSuspicious,
            llm_judgment: judgment,
        },
        duration_ms: Date.now() - started,
    };
}
