// src/review/dimensions/safety.ts
//
// 安全维度
//
// 校验点：
//   1. recommended_action / trigger_conditions / assertions.command 中不含黑名单关键字
//      （rm -rf /, sudo rm, dd if=, mkfs, fork bomb 等）
//   2. files_touched / command 中不触碰敏感路径（~/.ssh/, /etc/shadow, ~/code_key 等）
//   3. 不含硬编码密钥（sk-xxx / AKIA... / PEM 私钥）
//   4. assertion 的 command_allowlist 不允许 '*' 或空字符串
//
// 失败 → 不可挽救（安全问题一律 reject）
function collectTextBlobs(c) {
    const out = [];
    out.push(c.strategy.recommended_action ?? '');
    out.push(c.strategy.trigger_conditions ?? '');
    out.push(c.strategy.problem_category ?? '');
    for (const inst of c.instances) {
        out.push(inst.diff_summary ?? '');
        for (const a of inst.assertions ?? []) {
            if (typeof a.command === 'string')
                out.push(a.command);
            if (typeof a.description === 'string')
                out.push(a.description);
            if (Array.isArray(a.command_allowlist))
                out.push(a.command_allowlist.join(' '));
        }
    }
    return out;
}
function collectPaths(c) {
    const out = [];
    for (const inst of c.instances) {
        for (const f of inst.files_touched ?? [])
            out.push(f);
    }
    return out;
}
export async function reviewSafety(candidate, deps) {
    const started = Date.now();
    const cfg = deps.config;
    const hits = [];
    // 1) 黑名单关键字
    const blobs = collectTextBlobs(candidate);
    for (const blob of blobs) {
        const low = blob.toLowerCase();
        for (const kw of cfg.bannedKeywords) {
            if (low.includes(kw.toLowerCase())) {
                hits.push({ type: 'banned_keyword', value: kw, where: blob.slice(0, 120) });
            }
        }
    }
    // 2) 敏感路径（同时在 files_touched 和命令文本中检查）
    const pathsToCheck = [...collectPaths(candidate), ...blobs];
    for (const p of pathsToCheck) {
        const low = p.toLowerCase();
        for (const sensitive of cfg.sensitivePaths) {
            if (low.includes(sensitive.toLowerCase())) {
                hits.push({ type: 'sensitive_path', value: sensitive, where: p.slice(0, 120) });
            }
        }
    }
    // 3) 硬编码密钥
    for (const blob of blobs) {
        for (const re of cfg.secretPatterns) {
            const m = blob.match(re);
            if (m) {
                hits.push({ type: 'secret_pattern', value: re.source, where: m[0].slice(0, 40) + '...' });
            }
        }
    }
    // 4) assertion 的 command_allowlist 校验
    for (const inst of candidate.instances) {
        for (const a of inst.assertions ?? []) {
            if (Array.isArray(a.command_allowlist)) {
                for (const entry of a.command_allowlist) {
                    if (typeof entry !== 'string' || entry.trim() === '') {
                        hits.push({ type: 'bad_allowlist_entry', value: String(entry), where: `assertion:${a.type}` });
                    }
                    if (entry === '*' || entry === '**') {
                        hits.push({ type: 'wildcard_allowlist', value: entry, where: `assertion:${a.type}` });
                    }
                }
            }
        }
    }
    const pass = hits.length === 0;
    return {
        dimension: 'safety',
        pass,
        code: pass ? undefined : 'SAFETY_VIOLATION',
        reason: pass
            ? undefined
            : `safety violations: ${hits.map((h) => `${h.type}(${h.value})`).slice(0, 5).join('; ')}`,
        salvageable: false, // 安全问题不可挽救
        detail: { hits },
        duration_ms: Date.now() - started,
    };
}
