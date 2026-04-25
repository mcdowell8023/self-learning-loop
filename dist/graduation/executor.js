// src/graduation/executor.ts
//
// T-P1a-008 · Graduation Executor — orchestrates the write of a graduated
// candidate's artifact into the workspace and records a graduation_record.
//
// P1a scope (design §9.1):
//   - Only `scope: 'general'` is supported. It routes to AGENTS.md.
//   - Other scopes (tool:*, role:*, skill) are *rejected loudly*, not silently
//     skipped (per ticket risk-mitigation note).
//
// Flow (happy path):
//   1. Validate candidate state (must be in 'validating', i.e. ready to graduate)
//      and scope (= 'general').
//   2. Compute content_hash = sha256(body).
//   3. Write body to `<graduatedDir>/<hash>.md` (content-addressable, idempotent).
//   4. Inject marker block into target file (idempotent; if already present,
//      skip step 4 but still ensure steps 3, 5 are consistent).
//   5. Build + persist graduation_record YAML to `<auditDir>/graduations/<hash>.yaml`.
//   6. Transition candidate state validating → graduated (skipped if already).
//
// Partial failure rollback (§9.2.4, test #93):
//   If step 4 (marker injection) succeeds but step 5 (record write) fails, we
//   remove the marker block so the system is back to a consistent pre-write
//   state. The graduated/<hash>.md body remains (it's immutable; safe to leave).
//
// Checkpoint-missing abort (test #94):
//   If caller requests a rollback checkpoint (e.g. git commit hash) but none is
//   available AND `requireCheckpoint: true`, we abort before writing anything.
import { existsSync, mkdirSync, readFileSync, } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, hasMarkerBlock, injectMarkerBlock, removeMarkerBlock, } from './marker-block.js';
import { buildGraduationRecord, parseGraduationRecord, serializeGraduationRecord, } from './graduation-record.js';
// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class GraduationScopeError extends Error {
    scope;
    constructor(scope) {
        super(`Graduation rejected: scope "${scope}" is not supported in P1a ` +
            `(only "general" routes to AGENTS.md).`);
        this.scope = scope;
        this.name = 'GraduationScopeError';
    }
}
export class GraduationCheckpointMissingError extends Error {
    candidateId;
    constructor(candidateId) {
        super(`Graduation aborted for candidate ${candidateId}: rollback checkpoint ` +
            `is required but missing (requireCheckpoint=true).`);
        this.candidateId = candidateId;
        this.name = 'GraduationCheckpointMissingError';
    }
}
export class GraduationStateError extends Error {
    candidateId;
    state;
    constructor(candidateId, state) {
        super(`Graduation aborted for candidate ${candidateId}: illegal state "${state}" ` +
            `(must be "validating" to graduate).`);
        this.candidateId = candidateId;
        this.state = state;
        this.name = 'GraduationStateError';
    }
}
// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
export class GraduationExecutor {
    workspaceDir;
    graduatedDir;
    auditDir;
    graduationsDir;
    store;
    agentsPath;
    requireCheckpoint;
    defaultEnv;
    constructor(opts) {
        this.workspaceDir = opts.workspaceDir;
        this.graduatedDir = opts.graduatedDir ?? join(opts.workspaceDir, 'learn', 'graduated');
        this.auditDir = opts.auditDir ?? join(opts.workspaceDir, 'learn', 'audit');
        this.graduationsDir = join(this.auditDir, 'graduations');
        this.store = opts.store;
        this.agentsPath = join(opts.workspaceDir, opts.agentsFileName ?? 'AGENTS.md');
        this.requireCheckpoint = opts.requireCheckpoint ?? false;
        this.defaultEnv = opts.defaultEnvFingerprint ?? {
            runtime: 'openclaw',
            platform: 'linux',
            arch: 'x64',
        };
    }
    /** Resolve the routed target file for a given scope. P1a: only `general` allowed. */
    resolveTarget(scope) {
        if (scope === 'general')
            return this.agentsPath;
        throw new GraduationScopeError(scope);
    }
    /** Main entry: graduate a candidate. */
    graduate(input) {
        const { candidate, body, shadow } = input;
        const scope = candidate.strategy.scope;
        // --- (1) Pre-flight checks ---
        if (scope !== 'general') {
            throw new GraduationScopeError(scope);
        }
        if (candidate.state !== 'validating' &&
            candidate.state !== 'graduated' &&
            !input.skipStateTransition) {
            // Only 'validating' can perform the system-triggered graduate transition.
            // 'graduated' is allowed for idempotent re-apply (marker block re-inject).
            throw new GraduationStateError(candidate.candidate_id, candidate.state);
        }
        const checkpointGit = input.rollbackCheckpoint?.git_commit ?? null;
        if (this.requireCheckpoint && !checkpointGit) {
            throw new GraduationCheckpointMissingError(candidate.candidate_id);
        }
        // --- (2) Hash & instance resolution ---
        const content_hash = sha256Hex(body);
        const instance = (input.instanceId
            ? candidate.instances.find((i) => i.instance_id === input.instanceId)
            : candidate.instances[0]);
        if (!instance) {
            throw new Error(`Graduation aborted: candidate ${candidate.candidate_id} has no instance` +
                (input.instanceId ? ` with id ${input.instanceId}` : ''));
        }
        const target = this.resolveTarget(scope);
        ensureDir(dirname(target));
        ensureDir(this.graduatedDir);
        ensureDir(this.graduationsDir);
        // --- (3) Write content-addressable body (idempotent: skip if exists) ---
        const bodyPath = join(this.graduatedDir, `${content_hash}.md`);
        if (!existsSync(bodyPath)) {
            atomicWrite(bodyPath, body);
        }
        // --- (4) Inject marker block into target (idempotent) ---
        const alreadyInjected = hasMarkerBlock(target, content_hash);
        const injectResult = alreadyInjected
            ? { injected: false }
            : injectMarkerBlock(target, content_hash, body);
        // --- (5) Build + persist graduation_record YAML ---
        const recordInput = {
            candidate_id: candidate.candidate_id,
            strategy_id: candidate.strategy.strategy_id,
            instance_id: instance.instance_id,
            content_hash,
            shadow_trial_count: shadow.trial_count,
            l1_assertion_results: shadow.l1,
            l2_metrics_delta: shadow.l2,
            l3_judge: shadow.l3,
            l4_feedback: shadow.l4 ?? { action: null, reviewer: null },
            graduated_by: input.graduated_by ?? 'system',
            env_fingerprint: input.env_fingerprint ?? this.defaultEnv,
            scope,
            target_file: relative(this.workspaceDir, target) || target,
            injection_method: 'marker_block',
            rollback_checkpoint: {
                git_commit: checkpointGit,
            },
        };
        let record;
        let recordPath;
        try {
            record = buildGraduationRecord(recordInput);
            recordPath = join(this.graduationsDir, `${content_hash}.yaml`);
            // Atomic write so an interrupted yaml flush can't corrupt neighbours.
            atomicWrite(recordPath, serializeGraduationRecord(record));
        }
        catch (err) {
            // (6) Partial-failure rollback: if we *just* injected the marker block,
            // remove it so state matches the failed record persistence.
            if (injectResult.injected) {
                try {
                    removeMarkerBlock(target, content_hash);
                }
                catch { /* best effort */ }
            }
            throw err;
        }
        // --- (7) State transition (skip if idempotent re-apply or caller opted out) ---
        let transitioned = false;
        if (!input.skipStateTransition && this.store && candidate.state === 'validating') {
            this.store.transition(candidate.candidate_id, 'validating', 'graduated', 'graduate', { actor: 'system' });
            transitioned = true;
        }
        return {
            content_hash,
            target_file: target,
            record_path: recordPath,
            body_path: bodyPath,
            record,
            injected: injectResult.injected,
            transitioned,
        };
    }
    /**
     * Rollback: remove the marker block from the routed target.
     * Does NOT delete the graduated/<hash>.md content blob (content-addressable,
     * immutable) nor the graduation_record (audit trail — retain for history).
     *
     * Returns `{ removed: true }` if a block existed, else `{ removed: false }`.
     */
    rollback(scope, contentHash) {
        const target = this.resolveTarget(scope);
        const res = removeMarkerBlock(target, contentHash);
        return { removed: res.removed };
    }
    /**
     * Load a previously-persisted graduation_record by content hash, or null.
     */
    readRecord(contentHash) {
        const p = join(this.graduationsDir, `${contentHash}.yaml`);
        if (!existsSync(p))
            return null;
        const yaml = readFileSync(p, 'utf-8');
        return parseGraduationRecord(yaml);
    }
}
// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function sha256Hex(s) {
    return createHash('sha256').update(s, 'utf-8').digest('hex');
}
function ensureDir(dir) {
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
// Re-export for convenience
export { buildGraduationRecord, serializeGraduationRecord } from './graduation-record.js';
