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
const REQUIRED_FIELDS = [
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
export function buildGraduationRecord(input) {
    const graduated_at = input.graduated_at ?? new Date().toISOString();
    const marker_id = `graduated:sha256:${input.content_hash}`;
    const rollback_checkpoint = {
        git_commit: input.rollback_checkpoint?.git_commit ?? null,
        marker_id: input.rollback_checkpoint?.marker_id ?? marker_id,
    };
    const record = {
        ...input,
        graduated_at,
        rollback_checkpoint,
    };
    validateGraduationRecord(record);
    return record;
}
export function validateGraduationRecord(rec) {
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
export function serializeGraduationRecord(rec) {
    validateGraduationRecord(rec);
    return yamlStringify({ graduation_record: rec });
}
export function parseGraduationRecord(yaml) {
    const doc = yamlParse(yaml);
    if (!doc || typeof doc !== 'object' || !('graduation_record' in doc)) {
        throw new Error(`graduation_record YAML: missing top-level key "graduation_record"`);
    }
    const rec = doc.graduation_record;
    validateGraduationRecord(rec);
    return rec;
}
