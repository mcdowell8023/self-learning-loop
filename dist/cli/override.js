// src/cli/override.ts
//
// T-P1a-009 · Override CLI — `openclaw learn override force-graduate|force-retire`
//
// Purpose: provide a user-driven escape hatch that lets operators force a
// candidate into `graduated` or `retired` regardless of the normal §5.2
// state machine path (shadow evaluation, review, dormant TTL, ...).
//
// Governed by §5.2.2 transition rules #12 (force_graduate) and #13
// (force_retire):
//   #12: from = * except {graduated, rejected}  → graduated   (actor=user)
//   #13: from = * except {retired,   rejected}  → retired     (actor=user)
//
// Invariants:
//   - `--reason` is REQUIRED; empty/missing → non-zero exit.
//   - Illegal transitions (from graduated/rejected for #12, from retired/
//     rejected for #13) are loudly rejected — not silently ignored.
//   - Every successful override appends an `AuditEvent` to
//     `<auditDir>/overrides.jsonl` (action: override_graduate|override_retire).
//   - Force-graduate on a candidate already in `validating` routes through
//     `GraduationExecutor.graduate()` so the artifact is written to
//     AGENTS.md just like the normal path (with skipStateTransition=false so
//     the rule-#4 `graduate` transition runs). The audit event still records
//     the override intent for traceability.
//   - Force-graduate on other valid-source states (pending/reviewing/
//     conflict/dormant) performs a direct state transition via rule #12,
//     SKIPPING the artifact write (operator is explicitly bypassing shadow;
//     graduated content is expected to have been authored/applied
//     out-of-band). A graduation_record stub is NOT written in that case —
//     only the audit trail.
//
// CLI design choice: hand-written argv parser (no commander dep). Keeps the
// learning-loop package lean and the surface testable.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeMarkerBlock } from '../graduation/marker-block.js';
import Database from 'better-sqlite3';
import { CandidateNotFoundError, IllegalTransitionError, openCandidateStore, } from '../store/candidate-store.js';
import { GraduationExecutor } from '../graduation/executor.js';
const USAGE = [
    'Usage: openclaw learn override <command> <candidate_id> --reason "<text>" [options]',
    '',
    'Commands:',
    '  force-graduate <id>    Force candidate to graduated (rule #12; bypasses shadow).',
    '  force-retire   <id>    Force candidate to retired   (rule #13).',
    '  revert <id>            Revert a graduated candidate back to validated.',
    '',
    'Required:',
    '  --reason <text>        Human rationale written to audit log.',
    '',
    'Options:',
    '  --db <path>            Candidate Store SQLite path (default: <workspace>/learn/candidates.db).',
    '  --workspace <path>     Workspace dir for audit + AGENTS.md (default: $PWD).',
    '  --body-file <path>     (force-graduate only, when state=validating) body to inject. Defaults to empty placeholder.',
    '  --actor <name>         Override actor in audit record (default: "user").',
    '',
].join('\n');
export async function runOverride(opts) {
    const out = opts.stdout ?? ((s) => process.stdout.write(s));
    const err = opts.stderr ?? ((s) => process.stderr.write(s));
    const now = opts.now ?? (() => new Date());
    const uuid = opts.uuid ?? randomUUID;
    const cwd = opts.cwd ?? process.cwd();
    const parsed = parseArgs(opts.argv);
    if (parsed.kind === 'error') {
        err(parsed.message + '\n' + USAGE);
        return { exitCode: parsed.code, message: parsed.message };
    }
    if (parsed.kind === 'help') {
        out(USAGE);
        return { exitCode: 0 };
    }
    const { command, candidateId, reason, dbFlag, workspaceFlag, actor } = parsed;
    const workspace = resolvePath(workspaceFlag ?? cwd, cwd);
    const dbPath = dbFlag
        ? resolvePath(dbFlag, cwd)
        : join(workspace, 'learn', 'candidates.db');
    // db existence check (friendlier message than sqlite's own).
    if (!opts.store && dbPath !== ':memory:' && !existsSync(dbPath)) {
        const msg = `error: candidate store not found at ${dbPath}`;
        err(msg + '\n');
        return { exitCode: 2, message: msg };
    }
    const store = opts.store ?? openCandidateStore({ dbPath, defaultActor: 'user' });
    const ownsStore = !opts.store;
    try {
        const candidate = store.get(candidateId);
        if (!candidate) {
            const msg = `error: candidate not found: ${candidateId}`;
            err(msg + '\n');
            return { exitCode: 3, message: msg };
        }
        const fromState = candidate.state;
        let toState = 'validating';
        let action = 'force_graduate';
        let wroteArtifact = false;
        let targetFile;
        if (command === 'force-graduate') {
            action = 'force_graduate';
            toState = 'graduated';
            if (fromState === 'graduated' || fromState === 'rejected') {
                const msg = `error: illegal override: cannot force-graduate candidate ${candidateId} ` +
                    `from '${fromState}' (rule #12 excludes graduated/rejected).`;
                err(msg + '\n');
                return { exitCode: 4, message: msg };
            }
            if (fromState === 'validating') {
                // Route through GraduationExecutor so AGENTS.md gets the body.
                const executor = new GraduationExecutor({ workspaceDir: workspace, store });
                const body = opts.defaultBody ??
                    `<!-- force-graduated ${candidateId}: no body supplied via override CLI -->\n`;
                const res = executor.graduate({
                    candidate,
                    body,
                    shadow: {
                        trial_count: 0,
                        l1: { total: 0, passed: 0, failed: 0, skipped: 0 },
                        l2: { turns: 0, errors: 0, token_usage: 0, completion_rate: 0 },
                        l3: { verdict: 'pass', confidence: 0, rationale: `override: ${reason}` },
                    },
                    graduated_by: actor,
                });
                wroteArtifact = true;
                targetFile = res.target_file;
            }
            else {
                // Pending / reviewing / conflict / dormant → direct rule-#12 jump.
                store.transition(candidateId, fromState, 'graduated', 'force_graduate', {
                    actor: 'user',
                });
            }
        }
        else if (command === 'force-retire') {
            action = 'force_retire';
            toState = 'retired';
            if (fromState === 'retired' || fromState === 'rejected') {
                const msg = `error: illegal override: cannot force-retire candidate ${candidateId} ` +
                    `from '${fromState}' (rule #13 excludes retired/rejected).`;
                err(msg + '\n');
                return { exitCode: 4, message: msg };
            }
            store.transition(candidateId, fromState, 'retired', 'force_retire', {
                actor: 'user',
            });
        }
        else if (command === 'revert') {
            action = 'graduation_reverted';
            toState = 'validating';
            if (fromState !== 'graduated') {
                const msg = `error: illegal override: cannot revert candidate ${candidateId} ` +
                    `from '${fromState}' (revert only works on graduated candidates).`;
                err(msg + '\n');
                return { exitCode: 4, message: msg };
            }
            // Remove marker block if graduation record exists
            try {
                const gradDir = join(workspace, 'learn', 'audit', 'graduations');
                if (existsSync(gradDir)) {
                    const gradFiles = readdirSync(gradDir).filter((f) => f.endsWith('.yaml'));
                    for (const f of gradFiles) {
                        const content = readFileSync(join(gradDir, f), 'utf-8');
                        if (content.includes(candidateId)) {
                            const hashMatch = content.match(/content_hash:\s*([a-f0-9]{64})/);
                            if (hashMatch && hashMatch[1]) {
                                const targetMatch = content.match(/target_file:\s*(.+)/);
                                if (targetMatch && targetMatch[1]) {
                                    const targetPath = join(workspace, targetMatch[1].trim());
                                    if (existsSync(targetPath)) {
                                        removeMarkerBlock(targetPath, hashMatch[1]);
                                        wroteArtifact = true;
                                        targetFile = targetPath;
                                    }
                                }
                            }
                            break;
                        }
                    }
                }
            }
            catch { /* marker removal is best-effort */ }
            // Transition graduated → validating (no standard rule exists; direct DB update as escape hatch)
            const revertDbPath = join(workspace, 'learn', 'candidates.db');
            if (existsSync(revertDbPath)) {
                const directDb = new Database(revertDbPath);
                const nowTs = now().toISOString();
                directDb.prepare(`UPDATE candidate_state SET state = 'validating', updated_at = ? WHERE candidate_id = ?`).run(nowTs, candidateId);
                directDb.prepare(`INSERT INTO state_transitions (candidate_id, from_state, to_state, action, actor, dormant_reason, transitioned_at)
           VALUES (?, 'graduated', 'validating', 'graduation_reverted', ?, NULL, ?)`).run(candidateId, actor, nowTs);
                directDb.close();
            }
        }
        // Audit append
        const auditDir = join(workspace, 'learn', 'audit');
        const auditPath = join(auditDir, 'overrides.jsonl');
        const eventId = uuid();
        const audit = {
            event_id: eventId,
            type: 'candidate_override',
            timestamp: now().toISOString(),
            candidate_id: candidateId,
            actor,
            data: {
                action,
                from_state: fromState,
                to_state: toState,
                reason,
                wrote_artifact: wroteArtifact,
                ...(targetFile ? { target_file: targetFile } : {}),
            },
            summary: `${action} ${candidateId}: ${fromState} → ${toState} (${reason})`,
        };
        appendAudit(auditPath, audit);
        out(`✓ ${action}: ${candidateId}  ${fromState} → ${toState}` +
            (wroteArtifact ? `  [artifact: ${targetFile}]` : '') +
            `\n  audit: ${auditPath}#${eventId}\n`);
        return {
            exitCode: 0,
            action,
            candidateId,
            fromState,
            toState,
            auditPath,
            auditEventId: eventId,
            targetFile,
            wroteArtifact,
        };
    }
    catch (e) {
        if (e instanceof IllegalTransitionError) {
            const msg = `error: illegal transition: ${e.message}`;
            err(msg + '\n');
            return { exitCode: 4, message: msg };
        }
        if (e instanceof CandidateNotFoundError) {
            const msg = `error: candidate not found: ${candidateId}`;
            err(msg + '\n');
            return { exitCode: 3, message: msg };
        }
        const msg = `error: ${e.message ?? String(e)}`;
        err(msg + '\n');
        return { exitCode: 1, message: msg };
    }
    finally {
        if (ownsStore) {
            try {
                store.close();
            }
            catch { /* ignore */ }
        }
    }
}
export function parseArgs(argv) {
    if (argv.length === 0) {
        return { kind: 'error', code: 64, message: 'error: missing <command>' };
    }
    const first = argv[0];
    if (first === '-h' || first === '--help' || first === 'help') {
        return { kind: 'help' };
    }
    if (first !== 'force-graduate' && first !== 'force-retire' && first !== 'revert') {
        return { kind: 'error', code: 64, message: `error: unknown command: ${first}` };
    }
    const rest = argv.slice(1);
    let candidateId;
    let reason;
    let dbFlag;
    let workspaceFlag;
    let actor = 'user';
    for (let i = 0; i < rest.length; i++) {
        const tok = rest[i];
        if (tok === '--reason') {
            reason = rest[++i];
            if (reason === undefined) {
                return { kind: 'error', code: 64, message: 'error: --reason requires a value' };
            }
        }
        else if (tok.startsWith('--reason=')) {
            reason = tok.slice('--reason='.length);
        }
        else if (tok === '--db') {
            dbFlag = rest[++i];
            if (dbFlag === undefined) {
                return { kind: 'error', code: 64, message: 'error: --db requires a path' };
            }
        }
        else if (tok.startsWith('--db=')) {
            dbFlag = tok.slice('--db='.length);
        }
        else if (tok === '--workspace') {
            workspaceFlag = rest[++i];
            if (workspaceFlag === undefined) {
                return { kind: 'error', code: 64, message: 'error: --workspace requires a path' };
            }
        }
        else if (tok.startsWith('--workspace=')) {
            workspaceFlag = tok.slice('--workspace='.length);
        }
        else if (tok === '--actor') {
            const v = rest[++i];
            if (v === undefined) {
                return { kind: 'error', code: 64, message: 'error: --actor requires a value' };
            }
            actor = v;
        }
        else if (tok.startsWith('--actor=')) {
            actor = tok.slice('--actor='.length);
        }
        else if (tok.startsWith('-')) {
            return { kind: 'error', code: 64, message: `error: unknown flag: ${tok}` };
        }
        else {
            if (candidateId !== undefined) {
                return {
                    kind: 'error',
                    code: 64,
                    message: `error: unexpected positional argument: ${tok}`,
                };
            }
            candidateId = tok;
        }
    }
    if (!candidateId) {
        return { kind: 'error', code: 64, message: 'error: missing <candidate_id>' };
    }
    if (reason === undefined) {
        return {
            kind: 'error',
            code: 64,
            message: 'error: --reason is required (no default allowed for audit trail)',
        };
    }
    if (reason.trim() === '') {
        return {
            kind: 'error',
            code: 64,
            message: 'error: --reason must be non-empty',
        };
    }
    return {
        kind: 'ok',
        command: first,
        candidateId,
        reason,
        dbFlag,
        workspaceFlag,
        actor,
    };
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resolvePath(p, cwd) {
    return isAbsolute(p) ? p : join(cwd, p);
}
function appendAudit(path, event) {
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    appendFileSync(path, JSON.stringify(event) + '\n', 'utf-8');
}
