import type { EnvFingerprint } from '../kernel/types.js';
import type { CandidateStore } from '../store/candidate-store.js';
import type { SessionEvent } from '../reflect/reflection-prompt.js';
import { type MatcherConfig, type MatchResult } from './matcher.js';
import { TrialCollector } from './trial-collector.js';
export interface ShadowRunnerOptions {
    store: CandidateStore;
    /** 可选传入已存在的 collector（测试方便）；不传则 runner 自建一个。 */
    collector?: TrialCollector;
    /** 匹配器配置（覆盖默认） */
    matcherConfig?: Partial<MatcherConfig>;
    /**
     * 是否记录"不匹配"的 trial。
     * 默认 false（按 DoD：匹配失败 → 不记录）。
     * 调试/sample-bias 观测时可打开。
     */
    recordMisses?: boolean;
    /** Trial ID 生成器（测试可 mock） */
    trialIdFactory?: () => string;
}
export interface ObserveReport {
    sessionId: string;
    candidatesChecked: number;
    /** 每个候选的匹配结果（含 skip 原因） */
    perCandidate: Array<{
        candidate_id: string;
        state: string;
        matched: boolean;
        skipped?: string;
        match?: MatchResult;
        trial_id?: string;
    }>;
    matchedCount: number;
    trialsWritten: number;
}
export declare class ShadowRunner {
    private readonly store;
    private readonly collector;
    private readonly matcherConfig;
    private readonly recordMisses;
    private readonly trialIdFactory;
    constructor(opts: ShadowRunnerOptions);
    /**
     * 被动观察一个 session：对所有 validating 候选跑匹配，记录 trial。
     *
     * @param sessionId  会话唯一 ID（由 Adapter 提供）
     * @param events     该 session 的 SessionEvent 列表（完整或批次）
     * @param env        该 session 的 env_fingerprint（用于 trial 记录）
     */
    observe(sessionId: string, events: SessionEvent[], env: EnvFingerprint): ObserveReport;
    /** 手动刷盘 TrialCollector 的 buffer。 */
    flush(): number;
    /** 暴露 collector 用于统计查询。 */
    getCollector(): TrialCollector;
    private buildTrial;
}
