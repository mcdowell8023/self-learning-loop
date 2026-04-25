// src/graduation/graduation-record.ts
//
// T-P1a-008 · graduation_record YAML schema (design §9.3).
//
// Record is persisted as YAML to:
//   <auditDir>/graduations/<contentHash>.yaml
//
// Content hash = SHA-256 of the graduated body (used as `content_hash` and as
// the marker id suffix). For P1a we keep the hash scheme minimal — upstream
// content-addressable store (graduated/<hash>.md) reuses the same hash.

import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

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

  content_hash: string;       // SHA-256 of body; also used as marker hash
  shadow_trial_count: number;
  l1_assertion_results: L1AssertionSummary;
  l2_metrics_delta: L2MetricsDelta;
  l3_judge: L3JudgeSummary;
  l4_feedback: L4FeedbackSummary;

  graduated_at: string;
  graduated_by: string;                 // 'system' | `user:<name>`
  env_fingerprint: EnvFingerprint;

  scope: CandidateScope;
  target_file: string;                  // relative to workspace root
  injection_method: InjectionMethod;

  rollback_checkpoint: RollbackCheckpoint;
}

export interface GraduationRecordInput extends Omit<GraduationRecord, 'graduated_at' | 'rollback_checkpoint'> {
  graduated_at?: string;
  rollback_checkpoint?: Partial<RollbackCheckpoint>;
}

const REQUIRED_FIELDS: Array<keyof GraduationRecord> = [
  'candidate_id',
  'strategy_id',
  'instance_id',
  'content_hash',
  'shadow_trial_count',
  'l1_assertion_results',
  'l2_metrics_delta',
  'l3_judge',
  'l4_feedback',
  'graduated_at',
  'graduated_by',
  'env_fingerprint',
  'scope',
  'target_file',
  'injection_method',
  'rollback_checkpoint',
];

export function buildGraduationRecord(input: GraduationRecordInput): GraduationRecord {
  const graduated_at = input.graduated_at ?? new Date().toISOString();
  const marker_id = `graduated:sha256:${input.content_hash}`;
  const rollback_checkpoint: RollbackCheckpoint = {
    git_commit: input.rollback_checkpoint?.git_commit ?? null,
    marker_id: input.rollback_checkpoint?.marker_id ?? marker_id,
  };
  const record: GraduationRecord = {
    ...input,
    graduated_at,
    rollback_checkpoint,
  };
  validateGraduationRecord(record);
  return record;
}

export function validateGraduationRecord(rec: GraduationRecord): void {
  for (const k of REQUIRED_FIELDS) {
    if (rec[k] === undefined || rec[k] === null) {
      throw new Error(`graduation_record: missing required field "${k}"`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(rec.content_hash)) {
    throw new Error(`graduation_record: invalid content_hash`);
  }
  if (rec.injection_method !== 'marker_block' && rec.injection_method !== 'symlink') {
    throw new Error(`graduation_record: invalid injection_method "${rec.injection_method}"`);
  }
  if (rec.shadow_trial_count < 0) {
    throw new Error(`graduation_record: shadow_trial_count must be >= 0`);
  }
}

export function serializeGraduationRecord(rec: GraduationRecord): string {
  validateGraduationRecord(rec);
  return yamlStringify({ graduation_record: rec });
}

export function parseGraduationRecord(yaml: string): GraduationRecord {
  const doc = yamlParse(yaml);
  if (!doc || typeof doc !== 'object' || !('graduation_record' in doc)) {
    throw new Error(`graduation_record YAML: missing top-level key "graduation_record"`);
  }
  const rec = (doc as { graduation_record: GraduationRecord }).graduation_record;
  validateGraduationRecord(rec);
  return rec;
}
