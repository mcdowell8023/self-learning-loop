import type { CandidateScope, EnvFingerprint } from '../kernel/types.js';
export type InjectionMethod = 'marker_block' | 'symlink';
export interface L1AssertionSummary {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
}
export interface L2MetricsDelta {
    turns: number;
    errors: number;
    token_usage: number;
    completion_rate: number;
}
export interface L3JudgeSummary {
    verdict: 'pass' | 'fail' | 'inconclusive';
    confidence: number;
    rationale?: string;
}
export interface L4FeedbackSummary {
    action: string | null;
    reviewer: string | null;
}
export interface RollbackCheckpoint {
    git_commit: string | null;
    marker_id: string;
}
export interface GraduationRecord {
    candidate_id: string;
    strategy_id: string;
    instance_id: string;
    content_hash: string;
    shadow_trial_count: number;
    l1_assertion_results: L1AssertionSummary;
    l2_metrics_delta: L2MetricsDelta;
    l3_judge: L3JudgeSummary;
    l4_feedback: L4FeedbackSummary;
    graduated_at: string;
    graduated_by: string;
    env_fingerprint: EnvFingerprint;
    scope: CandidateScope;
    target_file: string;
    injection_method: InjectionMethod;
    rollback_checkpoint: RollbackCheckpoint;
}
export interface GraduationRecordInput extends Omit<GraduationRecord, 'graduated_at' | 'rollback_checkpoint'> {
    graduated_at?: string;
    rollback_checkpoint?: Partial<RollbackCheckpoint>;
}
export declare function buildGraduationRecord(input: GraduationRecordInput): GraduationRecord;
export declare function validateGraduationRecord(rec: GraduationRecord): void;
export declare function serializeGraduationRecord(rec: GraduationRecord): string;
export declare function parseGraduationRecord(yaml: string): GraduationRecord;
