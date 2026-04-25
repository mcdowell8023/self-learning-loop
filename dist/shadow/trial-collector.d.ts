import { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { TrialResult } from '../kernel/types.js';
import type { CandidateStore } from '../store/candidate-store.js';
export interface TrialCollectorOptions {
    /** 走 CandidateStore 共享同一 DB 连接（推荐） */
    store?: CandidateStore;
    /** 或直接传入 better-sqlite3 连接 */
    db?: BetterSqliteDatabase;
    /** 累积多少条 trial 自动 flush，默认 10；传 1 关闭批处理 */
    batchSize?: number;
}
export interface CandidateTrialStats {
    trial_count: number;
    match_count: number;
    /** 按 session 分组的 trial 计数（用于 sample_bias_protection 观测，Phase 1b 使用） */
    by_session: Record<string, number>;
}
export declare class TrialCollector {
    private db;
    private buffer;
    private readonly batchSize;
    constructor(opts: TrialCollectorOptions);
    /**
     * 记录一次 trial（无论 matched 与否都写入，方便统计“被观察过”）。
     * 但按 DoD 要求：匹配失败时调用方应传 matched=false 的 TrialResult；
     * 若调用方只在匹配成功时才调用，也完全合规（那样 trial_count === match_count）。
     *
     * 返回 true 表示已触发 flush。
     */
    record(trial: TrialResult, matched: boolean): boolean;
    /** 手动刷盘剩余 buffer。 */
    flush(): number;
    /** 返回某 candidate 的累计 trial / match 统计。 */
    getStats(candidateId: string): CandidateTrialStats;
    /** 读取某 candidate 的所有 TrialResult（测试/调试用）。 */
    listTrials(candidateId: string): TrialResult[];
    /** 当前 buffer 大小（测试用） */
    _bufferSize(): number;
}
