import { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { Candidate, CandidateScope, CandidateState, DormantReason, Instance, Strategy } from '../kernel/types.js';
export declare class IllegalTransitionError extends Error {
    readonly candidateId: string;
    readonly fromState: CandidateState;
    readonly toState: CandidateState;
    readonly action: string;
    readonly code = "ILLEGAL_TRANSITION";
    constructor(candidateId: string, fromState: CandidateState, toState: CandidateState, action: string, extra?: string);
}
export declare class CandidateNotFoundError extends Error {
    readonly candidateId: string;
    readonly code = "CANDIDATE_NOT_FOUND";
    constructor(candidateId: string);
}
export type TransitionActor = 'system' | 'user';
export interface TransitionRule {
    id: string;
    from: CandidateState | '*';
    to: CandidateState;
    action: string;
    actor: TransitionActor | 'both';
    /** 源 dormant_reason 必须匹配才允许转移（用于 10a/10b/11a/11b） */
    sourceDormantReason?: DormantReason;
    /** from='*' 时排除的状态（用于 #12/#13） */
    fromExcept?: CandidateState[];
}
export declare const TRANSITION_RULES: TransitionRule[];
export interface CandidateStoreOptions {
    /** SQLite 文件路径。传 ':memory:' 使用内存库（仅测试用）。 */
    dbPath: string;
    /** 自定义 migration 目录；默认使用打包内置的 migrations/。 */
    migrationsDir?: string;
    /** 创建时的默认 actor（transition 日志用），默认 'system'。 */
    defaultActor?: TransitionActor;
    /** §5.6.2 文件镜像目录。设置后每次状态变更自动写镜像。 */
    candidatesDir?: string;
}
export interface CreateCandidateInput {
    strategy: Strategy;
    /** 可选的初始 Instance（同步创建）。 */
    instances?: Instance[];
    /** 初始状态，默认 'pending'。 */
    initialState?: CandidateState;
    /** 若 initialState='dormant' 必须提供 reason。 */
    dormantReason?: DormantReason | null;
}
export interface ListFilter {
    state?: CandidateState | CandidateState[];
    scope?: CandidateScope | CandidateScope[];
    problemCategory?: string | string[];
    dormantReason?: DormantReason;
    /** 分页 */
    limit?: number;
    offset?: number;
}
export interface TransitionOptions {
    actor?: TransitionActor;
    /** 进入 dormant 时必须提供；其他转移忽略 */
    dormantReason?: DormantReason;
    /** 用于 10a/10b/11a/11b：显式指定期望的源 dormant_reason（不填则从当前状态推断） */
    expectedSourceDormantReason?: DormantReason;
}
export declare class CandidateStore {
    private db;
    private readonly defaultActor;
    private readonly candidatesDir;
    constructor(opts: CandidateStoreOptions);
    private runMigrations;
    close(): void;
    /** §5.6.2 尽力而为写镜像（失败只 warn，不回滚 SQLite） */
    private tryWriteMirror;
    /** 暴露底层 DB（测试专用）。 */
    _unsafeDb(): BetterSqliteDatabase;
    /** PRAGMA journal_mode 的实际值（测试用） */
    getJournalMode(): string;
    create(input: CreateCandidateInput): Candidate;
    private insertInstance;
    /** 为已存在的 Candidate 追加 Instance（会更新 strategy.instance_ids 列表）。 */
    addInstance(candidateId: string, inst: Instance): Candidate;
    get(candidateId: string): Candidate | null;
    /** 局部更新 Strategy（不改 ID / state）。 */
    updateStrategy(candidateId: string, patch: Partial<Omit<Strategy, 'strategy_id' | 'created_at'>>): Candidate;
    delete(candidateId: string): boolean;
    private touch;
    list(filter?: ListFilter): Candidate[];
    count(filter?: ListFilter): number;
    /**
     * 执行状态转移。
     * - fromState 为**期望**的当前状态，若不匹配则抛 IllegalTransitionError（乐观并发）。
     * - action 必须在 §5.2.2 规则表中存在。
     * - 进入 dormant 时必须在 opts.dormantReason 中提供 reason。
     * - 从 dormant 出发时，若规则指定了 sourceDormantReason，当前 dormant_reason 必须匹配。
     */
    transition(candidateId: string, fromState: CandidateState, toState: CandidateState, action: string, opts?: TransitionOptions): Candidate;
    /** 返回某候选的状态转移历史（审计用） */
    getTransitions(candidateId: string): Array<{
        from_state: string;
        to_state: string;
        action: string;
        actor: string;
        dormant_reason: string | null;
        transitioned_at: string;
    }>;
    /** 导出 Candidate 为 YAML 字符串（§5.1.5 格式）。 */
    exportYaml(candidateId: string): string;
    /**
     * 从 YAML 字符串导入 Candidate（upsert 语义：若 candidate_id 已存在则抛错，
     * 调用方可以先 delete 再 import）。
     */
    importYaml(yamlText: string): Candidate;
    getWatermark(key?: string): string | null;
    setWatermark(date: string, key?: string): void;
    hasReflectionLog(date: string, sourceHash: string): boolean;
    addReflectionLog(date: string, sourceHash: string, candidatesCount: number): void;
}
export declare function openCandidateStore(opts: CandidateStoreOptions): CandidateStore;
