// src/kernel/content-id.ts
// Content-Addressable ID 计算（§5.1.4）
// T-P1a-001 交付的最小子集。
import { createHash } from 'node:crypto';
function normalize(str) {
    return str.trim().replace(/\s+/g, ' ');
}
export function computeStrategyId(s) {
    const payload = `${normalize(s.problem_category)}\n` +
        `${normalize(s.trigger_conditions)}\n` +
        `${normalize(s.recommended_action)}`;
    return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
export function computeInstanceId(i) {
    const payload = `${i.strategy_id}\n` +
        `${normalize(i.diff_summary)}\n` +
        `${i.env_fingerprint.runtime}`;
    return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
