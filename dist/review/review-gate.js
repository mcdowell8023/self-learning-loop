// src/review/review-gate.ts
//
// Four-Dimension Review Gate 主编排器（T-P1a-004）
//
// 职责：
//   1. 按序执行四维：metadata → safety → conflict → semantic（§5.4.2 短路顺序）
//      - 不可挽救维度（metadata/safety）失败 → 立即短路
//      - 可挽救维度（conflict/semantic）失败 → 立即短路（但标记 salvageable=true）
//   2. 调 CandidateStore.transition：
//      - pending → reviewing（start_review）
//      - reviewing → rejected（review_failed）或 reviewing → validating（review_passed）
//   3. 每维产生 AuditLogEntry；整体产生一条 summary entry
//   4. 四个维度都可独立调用（export 原函数）
//
// 不直接依赖 CandidateStore 的具体实现（通过窄接口），但默认使用 CandidateStore.transition。
import { reviewMetadata } from './dimensions/metadata.js';
import { reviewSafety } from './dimensions/safety.js';
import { reviewConflict } from './dimensions/conflict.js';
import { reviewSemantic } from './dimensions/semantic.js';
import { DEFAULT_REVIEW_CONFIG, } from './types.js';
export { reviewMetadata, reviewSafety, reviewConflict, reviewSemantic };
export class ReviewGate {
    store;
    opts;
    config;
    reviewer;
    constructor(store, opts = {}) {
        this.store = store;
        this.opts = opts;
        this.config = { ...DEFAULT_REVIEW_CONFIG, ...(opts.config ?? {}) };
        this.reviewer = opts.reviewer ?? 'review-gate/system';
    }
    /** 注入 StrategyLookup（如果用 CandidateStore 自身做 lookup，可用 adapter） */
    static lookupFromStore(storeLike, excludeStates = ['rejected', 'retired']) {
        const activeStates = ['pending', 'reviewing', 'validating', 'conflict', 'graduated', 'dormant'].filter((s) => !excludeStates.includes(s));
        return {
            listActiveStrategies: () => storeLike.list({ state: activeStates }).map((c) => c.strategy),
        };
    }
    /**
     * 对候选执行完整四维审查，并驱动 Candidate Store 状态机。
     *
     * @param candidate 待审候选（从 Store 取出的最新对象）
     * @returns ReviewResult（含所有维度结果 + audit log）
     */
    async review(candidate) {
        // Step 1: pending → reviewing
        if (candidate.state === 'pending') {
            this.store.transition(candidate.candidate_id, 'pending', 'reviewing', 'start_review', { actor: 'system' });
        }
        else if (candidate.state !== 'reviewing') {
            throw new Error(`ReviewGate.review: candidate ${candidate.candidate_id} state is '${candidate.state}', ` +
                `expected 'pending' or 'reviewing'`);
        }
        const auditLog = [];
        const dimResults = [];
        const order = [
            {
                name: 'metadata',
                fn: () => reviewMetadata(candidate, { config: this.config }),
            },
            {
                name: 'safety',
                fn: () => reviewSafety(candidate, { config: this.config }),
            },
            {
                name: 'conflict',
                fn: () => reviewConflict(candidate, {
                    config: this.config,
                    rulesProvider: this.opts.rulesProvider,
                    llm: this.opts.llm,
                }),
            },
            {
                name: 'semantic',
                fn: () => reviewSemantic(candidate, {
                    config: this.config,
                    strategyLookup: this.opts.strategyLookup,
                    assertionRegistry: this.opts.assertionRegistry,
                }),
            },
        ];
        let failedAt;
        for (const step of order) {
            let res;
            try {
                res = await step.fn();
            }
            catch (err) {
                res = {
                    dimension: step.name,
                    pass: false,
                    code: 'REVIEW_EXCEPTION',
                    reason: err instanceof Error ? err.message : String(err),
                    salvageable: false,
                };
            }
            dimResults.push(res);
            const entry = this.buildDimensionEntry(candidate.candidate_id, res);
            auditLog.push(entry);
            await this.opts.auditSink?.append(entry);
            if (!res.pass) {
                failedAt = step.name;
                break; // 短路
            }
        }
        const pass = failedAt === undefined;
        const finalState = pass ? 'validating' : 'rejected';
        // Step 2: 驱动状态机到终态
        this.store.transition(candidate.candidate_id, 'reviewing', finalState, pass ? 'review_passed' : 'review_failed', { actor: 'system' });
        // Step 3: Summary audit entry
        const summary = {
            timestamp: new Date().toISOString(),
            candidate_id: candidate.candidate_id,
            kind: 'summary',
            reviewer: this.reviewer,
            pass,
            code: pass ? undefined : dimResults[dimResults.length - 1]?.code,
            reason: pass
                ? 'all dimensions passed'
                : `failed at dimension '${failedAt}': ${dimResults[dimResults.length - 1]?.reason ?? 'unknown'}`,
            detail: {
                failed_at: failedAt,
                final_state: finalState,
                dimensions_run: dimResults.map((d) => ({
                    dimension: d.dimension,
                    pass: d.pass,
                    code: d.code,
                    salvageable: d.salvageable ?? false,
                })),
            },
        };
        auditLog.push(summary);
        await this.opts.auditSink?.append(summary);
        return {
            candidate_id: candidate.candidate_id,
            pass,
            failed_at: failedAt,
            dimensions: dimResults,
            reviewed_by: this.reviewer,
            reviewed_at: summary.timestamp,
            final_state: finalState,
            audit_log: auditLog,
        };
    }
    buildDimensionEntry(candidateId, res) {
        return {
            timestamp: new Date().toISOString(),
            candidate_id: candidateId,
            kind: 'dimension',
            dimension: res.dimension,
            reviewer: this.reviewer,
            pass: res.pass,
            code: res.code,
            reason: res.reason,
            detail: {
                duration_ms: res.duration_ms,
                salvageable: res.salvageable,
                ...(res.detail ?? {}),
            },
        };
    }
}
// -------------------------------------------------------------------------
// 便捷工厂
// -------------------------------------------------------------------------
export function createReviewGate(store, opts = {}) {
    return new ReviewGate(store, opts);
}
/** 内存 audit sink（测试用） */
export class InMemoryAuditSink {
    entries = [];
    append(entry) {
        this.entries.push(entry);
    }
}
// 便捷：让 CandidateStore 直接作为 StrategyLookup 使用
export function strategyLookupFromCandidateStore(store, excludeStates = ['rejected', 'retired']) {
    return ReviewGate.lookupFromStore(store, excludeStates);
}
