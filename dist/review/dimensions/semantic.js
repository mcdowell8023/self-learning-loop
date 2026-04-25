// src/review/dimensions/semantic.ts
//
// 语义维度（映射 v5.0.3 §5.4 D3 唯一性 + D4 可验证性的质量变体）
//
// 校验点：
//   1. 文本质量：recommended_action / trigger_conditions 长度达标，非空
//   2. 结构化：recommended_action 不只是单个词、含有动词迹象
//   3. 可验证性（可选开关 cfg.requireVerifiableAssertion）：至少一条 assertion.type 在 registry
//   4. 相似度去重：与 Strategy Store 中既有 active Strategy 的文本相似度 < 阈值
//      相似度 = 取 (recommended_action + trigger_conditions) n-gram Jaccard
//
// 失败 → 可挽救（低质量/重复可通过反思改写或合并为新 Instance）
import { textSimilarity } from '../util/similarity.js';
function candidateSignature(s) {
    return `${s.recommended_action ?? ''} || ${s.trigger_conditions ?? ''}`;
}
export async function reviewSemantic(candidate, deps) {
    const started = Date.now();
    const cfg = deps.config;
    const s = candidate.strategy;
    const errors = [];
    const warnings = [];
    // 1) 文本质量
    const action = (s.recommended_action ?? '').trim();
    const trigger = (s.trigger_conditions ?? '').trim();
    if (action.length < cfg.minActionLength) {
        errors.push(`action_too_short:${action.length}<${cfg.minActionLength}`);
    }
    if (trigger.length < cfg.minTriggerLength) {
        errors.push(`trigger_too_short:${trigger.length}<${cfg.minTriggerLength}`);
    }
    // 2) 结构化：action 至少含 2 个 token（避免 "do" / "fix" 这种单词动作）
    const actionTokens = action.split(/\s+/).filter((x) => x.length > 0);
    if (actionTokens.length < 2 && errors.length === 0) {
        errors.push('action_not_structured:single_token');
    }
    // 3) 可验证性
    if (cfg.requireVerifiableAssertion) {
        const hasRegistered = candidate.instances.length > 0 &&
            candidate.instances.some((inst) => (inst.assertions ?? []).some((a) => deps.assertionRegistry ? deps.assertionRegistry.hasType(a.type) : false));
        if (!hasRegistered) {
            errors.push('no_verifiable_assertion');
        }
    }
    else {
        // 软检查：无任何 assertion 时告警，不 fail
        const any = candidate.instances.some((inst) => (inst.assertions ?? []).length > 0);
        if (!any)
            warnings.push('no_assertion_defined');
    }
    // 4) 相似度去重（短路：质量问题优先）
    let maxSim = 0;
    let dupStrategyId;
    if (errors.length === 0 && deps.strategyLookup) {
        const sig = candidateSignature(s);
        const existing = deps.strategyLookup.listActiveStrategies();
        for (const other of existing) {
            // 跳过自己
            if (other.strategy_id === s.strategy_id)
                continue;
            const sim = textSimilarity(sig, candidateSignature(other), cfg.ngramSize);
            if (sim > maxSim) {
                maxSim = sim;
                dupStrategyId = other.strategy_id;
            }
        }
        if (maxSim >= cfg.similarityThreshold) {
            errors.push(`duplicate:${dupStrategyId}@${maxSim.toFixed(3)}`);
        }
    }
    const pass = errors.length === 0;
    const isDup = pass ? false : errors.some((e) => e.startsWith('duplicate:'));
    return {
        dimension: 'semantic',
        pass,
        code: pass ? undefined : isDup ? 'DUPLICATE' : 'LOW_QUALITY',
        reason: pass ? undefined : `semantic issues: ${errors.join(', ')}`,
        salvageable: true, // 语义问题都可挽救
        detail: {
            errors,
            warnings,
            maxSimilarity: maxSim,
            duplicateOf: dupStrategyId,
        },
        duration_ms: Date.now() - started,
    };
}
