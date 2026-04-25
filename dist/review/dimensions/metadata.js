// src/review/dimensions/metadata.ts
//
// 元信息维度（映射 v5.0.3 §5.4 D1 Schema 校验）
//
// 校验点：
//   1. 必填字段存在且非空（scope / problem_category / trigger_conditions / recommended_action）
//   2. scope 格式合法（general / skill / tool:xxx / role:xxx）
//   3. confidence 字段（若存在）在 [0, 1]
//   4. created_by 字段（若存在于 tags 或 extra）非空
//   5. strategy_id / instance_ids 格式正确（字符串非空）
//
// 失败 → 不可挽救（code=SCHEMA_INVALID）
export async function reviewMetadata(candidate, deps) {
    const started = Date.now();
    const cfg = deps.config;
    const s = candidate.strategy;
    const errors = [];
    // 1) 必填字段
    for (const field of cfg.requiredFields) {
        const v = s[field];
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
            errors.push(`missing_or_empty:${field}`);
        }
    }
    // 2) strategy_id 非空
    if (!s.strategy_id || typeof s.strategy_id !== 'string' || s.strategy_id.trim() === '') {
        errors.push('invalid_strategy_id');
    }
    // 3) scope 格式
    if (typeof s.scope === 'string' && s.scope.trim() !== '') {
        const ok = cfg.allowedScopePatterns.some((re) => re.test(s.scope));
        if (!ok)
            errors.push(`invalid_scope_format:${s.scope}`);
    }
    // 4) confidence 范围（如果存在于 extra 字段；Strategy 未定义该字段，从 tags 或额外 JSON 中探测）
    const extra = s;
    if ('confidence' in extra) {
        const c = extra['confidence'];
        if (typeof c !== 'number' || Number.isNaN(c) || c < 0 || c > 1) {
            errors.push(`invalid_confidence:${String(c)}`);
        }
    }
    // 5) created_by（from tags 'created_by:xxx' 或 extra 字段）
    const hasCreatedByTag = Array.isArray(s.tags) && s.tags.some((t) => typeof t === 'string' && t.startsWith('created_by:'));
    if ('created_by' in extra) {
        const cb = extra['created_by'];
        if (typeof cb !== 'string' || cb.trim() === '') {
            errors.push('invalid_created_by');
        }
    }
    else if (!hasCreatedByTag) {
        // created_by 要求从 tags 里体现，如果既无 extra 也无 tag → 警告但不 fail
        // 策略：列入必填时才 fail。当前默认不列入，因此此处不加 error。
    }
    // 6) instance_ids 一致性
    if (!Array.isArray(s.instance_ids)) {
        errors.push('invalid_instance_ids_array');
    }
    // 7) tags 格式（若存在必须是字符串数组）
    if (s.tags !== undefined && !Array.isArray(s.tags)) {
        errors.push('invalid_tags_format');
    }
    // 8) problem_category 字符长度基本要求
    if (typeof s.problem_category === 'string' && s.problem_category.length > 200) {
        errors.push('problem_category_too_long');
    }
    const pass = errors.length === 0;
    return {
        dimension: 'metadata',
        pass,
        code: pass ? undefined : 'SCHEMA_INVALID',
        reason: pass ? undefined : `metadata check failed: ${errors.join(', ')}`,
        salvageable: false, // D1 不可挽救
        detail: { errors },
        duration_ms: Date.now() - started,
    };
}
