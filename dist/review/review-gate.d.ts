import type { Candidate, CandidateState } from '../kernel/types.js';
import type { CandidateStore } from '../store/candidate-store.js';
import { reviewMetadata } from './dimensions/metadata.js';
import { reviewSafety } from './dimensions/safety.js';
import { reviewConflict } from './dimensions/conflict.js';
import { reviewSemantic } from './dimensions/semantic.js';
import { type AssertionRegistry, type AuditLogEntry, type ExistingRulesProvider, type LlmJudge, type ReviewGateConfig, type ReviewResult, type StrategyLookup } from './types.js';
export { reviewMetadata, reviewSafety, reviewConflict, reviewSemantic };
/** 审计日志 sink（每条 entry 都会推过来；子类可转发到 file / DB） */
export interface AuditLogSink {
    append(entry: AuditLogEntry): void | Promise<void>;
}
/** 只使用到的最窄接口，便于测试 mock（真实传 CandidateStore 即可兼容） */
export interface TransitionCapableStore {
    transition(candidateId: string, fromState: CandidateState, toState: CandidateState, action: string, opts?: {
        actor?: 'system' | 'user';
        dormantReason?: 'no_match' | 'inconclusive';
    }): Candidate;
    get(candidateId: string): Candidate | null;
}
export interface ReviewGateOptions {
    config?: Partial<ReviewGateConfig>;
    rulesProvider?: ExistingRulesProvider;
    llm?: LlmJudge;
    strategyLookup?: StrategyLookup;
    assertionRegistry?: AssertionRegistry;
    auditSink?: AuditLogSink;
    /** 审查者标识（写入 audit log） */
    reviewer?: string;
}
export declare class ReviewGate {
    private readonly store;
    private readonly opts;
    private readonly config;
    private readonly reviewer;
    constructor(store: TransitionCapableStore, opts?: ReviewGateOptions);
    /** 注入 StrategyLookup（如果用 CandidateStore 自身做 lookup，可用 adapter） */
    static lookupFromStore(storeLike: {
        list: (filter: {
            state: CandidateState[];
        }) => Candidate[];
    }, excludeStates?: CandidateState[]): StrategyLookup;
    /**
     * 对候选执行完整四维审查，并驱动 Candidate Store 状态机。
     *
     * @param candidate 待审候选（从 Store 取出的最新对象）
     * @returns ReviewResult（含所有维度结果 + audit log）
     */
    review(candidate: Candidate): Promise<ReviewResult>;
    private buildDimensionEntry;
}
export declare function createReviewGate(store: TransitionCapableStore, opts?: ReviewGateOptions): ReviewGate;
/** 内存 audit sink（测试用） */
export declare class InMemoryAuditSink implements AuditLogSink {
    readonly entries: AuditLogEntry[];
    append(entry: AuditLogEntry): void;
}
export declare function strategyLookupFromCandidateStore(store: CandidateStore, excludeStates?: CandidateState[]): StrategyLookup;
