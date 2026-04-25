import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GraduationExecutor, GraduationScopeError, GraduationStateError, GraduationCheckpointMissingError } from './executor.js';
import { hasMarkerBlock, injectMarkerBlock, removeMarkerBlock, atomicWrite, markerLines, readMarkerBlock } from './marker-block.js';
import { buildGraduationRecord, parseGraduationRecord, serializeGraduationRecord, validateGraduationRecord } from './graduation-record.js';
import { openCandidateStore } from '../store/candidate-store.js';
import type { Candidate, Strategy, Instance, EnvFingerprint, CandidateScope } from '../kernel/types.js';

// Shared test workspace root (under os.tmpdir()). TEST ISOLATION:
// All file I/O in this file goes through these per-test tmp dirs — the real
// workspace AGENTS.md at ~/.openclaw/workspace/AGENTS.md is NEVER touched.

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'graduation-spec-'));
});

afterEach(() => {
  // Safety: assert we never accidentally point at a real workspace.
  if (!tmpRoot.includes(tmpdir())) {
    throw new Error(`refusing to clean non-tmp path: ${tmpRoot}`);
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ENV: EnvFingerprint = {
  runtime: 'openclaw',
  platform: 'linux',
  arch: 'x64',
  model: 'test-model',
};

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function mkStrategy(scope: CandidateScope = 'general', id?: string): Strategy {
  const sid = id ?? sha(`strategy-${Math.random()}`);
  return {
    strategy_id: sid,
    problem_category: 'test_category',
    trigger_conditions: 'when something happens',
    recommended_action: 'do the thing',
    scope,
    tags: ['test'],
    created_at: new Date().toISOString(),
    instance_ids: [sid + '-inst'],
  };
}

function mkInstance(strategyId: string): Instance {
  return {
    instance_id: strategyId + '-inst',
    strategy_id: strategyId,
    diff_summary: 'diff',
    files_touched: ['a.ts'],
    env_fingerprint: ENV,
    source_sessions: [{ session_id: 's1', runtime: 'openclaw', timestamp: new Date().toISOString() }],
    assertions: [],
    trial_results: [],
    created_at: new Date().toISOString(),
  };
}

function mkCandidate(scope: CandidateScope = 'general', state: Candidate['state'] = 'validating'): Candidate {
  const strategy = mkStrategy(scope);
  const instance = mkInstance(strategy.strategy_id);
  return {
    candidate_id: strategy.strategy_id,
    strategy,
    instances: [instance],
    state,
    created_at: strategy.created_at,
    updated_at: strategy.created_at,
  };
}

const DEFAULT_SHADOW = {
  trial_count: 5,
  l1: { total: 15, passed: 15, failed: 0, skipped: 0 },
  l2: { turns: -0.3, errors: -1.2, token_usage: -500, completion_rate: 0.05 },
  l3: { verdict: 'pass' as const, confidence: 0.85, rationale: 'ok' },
};

// ===========================================================================
// marker-block module
// ===========================================================================

describe('marker-block: format', () => {
  it('markerLines produces well-formed start/end comments', () => {
    const h = 'a'.repeat(64);
    const { start, end } = markerLines(h);
    expect(start).toBe(`<!-- graduated:sha256:${h} start -->`);
    expect(end).toBe(`<!-- graduated:sha256:${h} end -->`);
  });

  it('markerLines rejects non-sha256 values', () => {
    expect(() => markerLines('notahash')).toThrow(/Invalid SHA-256/);
    expect(() => markerLines('A'.repeat(64))).toThrow(/Invalid SHA-256/); // uppercase
    expect(() => markerLines('z'.repeat(64))).toThrow(/Invalid SHA-256/); // non-hex
  });
});

describe('marker-block: injectMarkerBlock [#63 marker_block_create]', () => {
  it('creates target file when missing and injects block', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    const h = sha('rule-1');
    const res = injectMarkerBlock(target, h, '## Rule 1\n\nBody text.');
    expect(res.injected).toBe(true);
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, 'utf-8');
    expect(content).toContain(`<!-- graduated:sha256:${h} start -->`);
    expect(content).toContain(`<!-- graduated:sha256:${h} end -->`);
    expect(content).toContain('## Rule 1');
  });

  it('appends block to existing file without clobbering prior content', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    writeFileSync(target, '# Existing\n\nSome prior user content.\n');
    const h = sha('rule-2');
    injectMarkerBlock(target, h, 'Body 2');
    const content = readFileSync(target, 'utf-8');
    expect(content).toMatch(/^# Existing\n\nSome prior user content\.\n/);
    expect(content).toContain(`graduated:sha256:${h}`);
  });

  it('tolerates user manually editing around existing marker block', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    const h = sha('rule-3');
    injectMarkerBlock(target, h, 'Auto body');
    // Simulate user adding their own notes around the marker block.
    const original = readFileSync(target, 'utf-8');
    writeFileSync(target, `# Top\n\nNote from user above.\n\n${original}\n\n## User section below\n`);
    expect(hasMarkerBlock(target, h)).toBe(true);
    expect(readMarkerBlock(target, h)).toContain('Auto body');
  });
});

describe('marker-block: removeMarkerBlock [#64 marker_block_rollback]', () => {
  it('removes block cleanly and preserves surrounding content', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    writeFileSync(target, '# Header\n\nuser text\n');
    const h = sha('rule-rollback');
    injectMarkerBlock(target, h, 'graduated body');
    expect(hasMarkerBlock(target, h)).toBe(true);
    const res = removeMarkerBlock(target, h);
    expect(res.removed).toBe(true);
    const content = readFileSync(target, 'utf-8');
    expect(content).not.toContain(`graduated:sha256:${h}`);
    expect(content).toContain('# Header');
    expect(content).toContain('user text');
  });

  it('returns not_found when no block exists', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    writeFileSync(target, '# Header\n');
    const h = sha('never-injected');
    const res = removeMarkerBlock(target, h);
    expect(res.removed).toBe(false);
    expect(res.reason).toBe('not_found');
  });

  it('removes only the targeted hash block when multiple coexist', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    const h1 = sha('r1');
    const h2 = sha('r2');
    injectMarkerBlock(target, h1, 'body 1');
    injectMarkerBlock(target, h2, 'body 2');
    removeMarkerBlock(target, h1);
    expect(hasMarkerBlock(target, h1)).toBe(false);
    expect(hasMarkerBlock(target, h2)).toBe(true);
  });
});

describe('marker-block: atomicWrite [#92 marker_block_atomic_write]', () => {
  it('writes content via tmp file + rename', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    atomicWrite(target, 'v1\n');
    expect(readFileSync(target, 'utf-8')).toBe('v1\n');
    atomicWrite(target, 'v2\n');
    expect(readFileSync(target, 'utf-8')).toBe('v2\n');
  });

  it('cleans up tmp file on write failure (target dir missing)', () => {
    const bogus = join(tmpRoot, 'no-such-dir', 'AGENTS.md');
    expect(() => atomicWrite(bogus, 'data')).toThrow();
    // no stray .tmp.* should survive — dir didn't even exist
    expect(existsSync(bogus)).toBe(false);
  });

  it('does not leave a .tmp.* file in the target dir after success', () => {
    const target = join(tmpRoot, 'AGENTS.md');
    atomicWrite(target, 'hi\n');
    const { readdirSync } = require('node:fs');
    const files: string[] = readdirSync(tmpRoot);
    expect(files.filter((f: string) => f.includes('.tmp.'))).toEqual([]);
  });
});

// ===========================================================================
// graduation-record module
// ===========================================================================

describe('graduation-record: build + validate', () => {
  const baseInput = () => ({
    candidate_id: 'sha256:' + 'a'.repeat(64),
    strategy_id: 'sha256:' + 'b'.repeat(64),
    instance_id: 'sha256:' + 'c'.repeat(64),
    content_hash: 'd'.repeat(64),
    shadow_trial_count: 5,
    l1_assertion_results: { total: 10, passed: 10, failed: 0, skipped: 0 },
    l2_metrics_delta: { turns: 0, errors: 0, token_usage: 0, completion_rate: 0 },
    l3_judge: { verdict: 'pass' as const, confidence: 0.9 },
    l4_feedback: { action: null, reviewer: null },
    graduated_by: 'system',
    env_fingerprint: ENV,
    scope: 'general' as CandidateScope,
    target_file: 'AGENTS.md',
    injection_method: 'marker_block' as const,
  });

  it('builds a valid record with defaults', () => {
    const rec = buildGraduationRecord(baseInput());
    expect(rec.graduated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rec.rollback_checkpoint.marker_id).toBe(`graduated:sha256:${rec.content_hash}`);
    expect(rec.rollback_checkpoint.git_commit).toBeNull();
  });

  it('rejects invalid content_hash', () => {
    expect(() => buildGraduationRecord({ ...baseInput(), content_hash: 'short' })).toThrow(/content_hash/);
  });

  it('round-trips through YAML', () => {
    const rec = buildGraduationRecord(baseInput());
    const yaml = serializeGraduationRecord(rec);
    expect(yaml).toContain('graduation_record:');
    const parsed = parseGraduationRecord(yaml);
    expect(parsed.content_hash).toBe(rec.content_hash);
    expect(parsed.l3_judge.confidence).toBe(0.9);
  });

  it('rejects YAML missing top-level key', () => {
    expect(() => parseGraduationRecord('foo: bar\n')).toThrow(/graduation_record/);
  });

  it('validateGraduationRecord flags invalid injection_method', () => {
    const rec = buildGraduationRecord(baseInput());
    // @ts-expect-error -- deliberately inject bad value
    rec.injection_method = 'nope';
    expect(() => validateGraduationRecord(rec)).toThrow(/injection_method/);
  });
});

// ===========================================================================
// GraduationExecutor — core flow
// ===========================================================================

function mkExecutor(opts: { store?: ReturnType<typeof openCandidateStore>; requireCheckpoint?: boolean } = {}) {
  return new GraduationExecutor({
    workspaceDir: tmpRoot,
    store: opts.store,
    requireCheckpoint: opts.requireCheckpoint,
    defaultEnvFingerprint: ENV,
  });
}

describe('GraduationExecutor: scope routing [#65 scope_route_general]', () => {
  it('routes general → AGENTS.md', () => {
    const exec = mkExecutor();
    expect(exec.resolveTarget('general')).toBe(join(tmpRoot, 'AGENTS.md'));
  });

  it('rejects tool:* scope (no silent skip)', () => {
    const exec = mkExecutor();
    expect(() => exec.resolveTarget('tool:chrome-cdp')).toThrow(GraduationScopeError);
  });

  it('rejects role:* scope', () => {
    const exec = mkExecutor();
    expect(() => exec.resolveTarget('role:luban')).toThrow(GraduationScopeError);
  });

  it('rejects skill scope', () => {
    const exec = mkExecutor();
    expect(() => exec.resolveTarget('skill')).toThrow(GraduationScopeError);
  });

  it('graduate() throws GraduationScopeError for non-general candidate', () => {
    const exec = mkExecutor();
    const cand = mkCandidate('tool:chrome-cdp');
    expect(() => exec.graduate({ candidate: cand, body: 'x', shadow: DEFAULT_SHADOW })).toThrow(GraduationScopeError);
  });
});

describe('GraduationExecutor: happy path', () => {
  it('writes body, injects marker, persists record, transitions state', () => {
    const store = openCandidateStore({ dbPath: ':memory:' });
    try {
      const cand = mkCandidate('general');
      store.create({ strategy: cand.strategy, instances: [cand.instances[0]!] });
      store.transition(cand.candidate_id, 'pending', 'reviewing', 'start_review');
      store.transition(cand.candidate_id, 'reviewing', 'validating', 'review_passed');
      const fresh = store.get(cand.candidate_id)!;
      const exec = mkExecutor({ store });
      const body = '## Rule\n\nclean up /tmp after tasks.';
      const res = exec.graduate({ candidate: fresh, body, shadow: DEFAULT_SHADOW });

      expect(res.injected).toBe(true);
      expect(res.transitioned).toBe(true);
      // marker block in AGENTS.md
      expect(hasMarkerBlock(res.target_file, res.content_hash)).toBe(true);
      // content-addressable body
      expect(existsSync(res.body_path)).toBe(true);
      expect(readFileSync(res.body_path, 'utf-8')).toBe(body);
      // record yaml
      expect(existsSync(res.record_path)).toBe(true);
      const parsed = parseGraduationRecord(readFileSync(res.record_path, 'utf-8'));
      expect(parsed.candidate_id).toBe(cand.candidate_id);
      expect(parsed.scope).toBe('general');
      expect(parsed.target_file).toBe('AGENTS.md');
      expect(parsed.injection_method).toBe('marker_block');
      // state moved to graduated
      expect(store.get(cand.candidate_id)!.state).toBe('graduated');
    } finally {
      store.close();
    }
  });

  it('uses workspace-relative target_file in record even if workspace is deep', () => {
    const cand = mkCandidate('general');
    const exec = mkExecutor();
    const res = exec.graduate({ candidate: cand, body: 'body', shadow: DEFAULT_SHADOW, skipStateTransition: true });
    expect(res.record.target_file).toBe('AGENTS.md');
  });

  it('embeds rollback_checkpoint.git_commit when provided', () => {
    const cand = mkCandidate('general');
    const exec = mkExecutor();
    const res = exec.graduate({
      candidate: cand, body: 'body', shadow: DEFAULT_SHADOW,
      rollbackCheckpoint: { git_commit: 'abc123def' },
      skipStateTransition: true,
    });
    expect(res.record.rollback_checkpoint.git_commit).toBe('abc123def');
  });
});

describe('GraduationExecutor: illegal state guard', () => {
  it('rejects graduation from pending state', () => {
    const exec = mkExecutor();
    const cand = mkCandidate('general', 'pending');
    expect(() => exec.graduate({ candidate: cand, body: 'b', shadow: DEFAULT_SHADOW })).toThrow(GraduationStateError);
  });

  it('rejects graduation from retired state', () => {
    const exec = mkExecutor();
    const cand = mkCandidate('general', 'retired');
    expect(() => exec.graduate({ candidate: cand, body: 'b', shadow: DEFAULT_SHADOW })).toThrow(GraduationStateError);
  });
});

describe('GraduationExecutor: idempotency [#95 double_apply_idempotent]', () => {
  it('double graduate() of same body → marker injected once, no throw', () => {
    const cand = mkCandidate('general');
    const exec = mkExecutor();
    const r1 = exec.graduate({ candidate: cand, body: 'B1', shadow: DEFAULT_SHADOW, skipStateTransition: true });
    expect(r1.injected).toBe(true);
    // pretend state is now 'graduated' — second call must not throw
    const cand2: Candidate = { ...cand, state: 'graduated' };
    const r2 = exec.graduate({ candidate: cand2, body: 'B1', shadow: DEFAULT_SHADOW, skipStateTransition: true });
    expect(r2.injected).toBe(false);
    expect(r2.content_hash).toBe(r1.content_hash);
    // AGENTS.md contains exactly one start marker
    const content = readFileSync(r1.target_file, 'utf-8');
    const matches = content.match(new RegExp(`graduated:sha256:${r1.content_hash} start`, 'g'))!;
    expect(matches.length).toBe(1);
  });

  it('second call still writes/keeps graduation_record (idempotent YAML)', () => {
    const cand = mkCandidate('general');
    const exec = mkExecutor();
    const r1 = exec.graduate({ candidate: cand, body: 'B-idem', shadow: DEFAULT_SHADOW, skipStateTransition: true });
    const firstMtime = readFileSync(r1.record_path, 'utf-8');
    const cand2: Candidate = { ...cand, state: 'graduated' };
    exec.graduate({ candidate: cand2, body: 'B-idem', shadow: DEFAULT_SHADOW, skipStateTransition: true });
    // content stays valid
    const parsed = parseGraduationRecord(readFileSync(r1.record_path, 'utf-8'));
    expect(parsed.content_hash).toBe(r1.content_hash);
    expect(firstMtime.length).toBeGreaterThan(0);
  });
});

describe('GraduationExecutor: rollback', () => {
  it('removes marker block via rollback() and preserves surrounding content', () => {
    const cand = mkCandidate('general');
    const exec = mkExecutor();
    // Seed AGENTS.md with user content first
    const target = join(tmpRoot, 'AGENTS.md');
    writeFileSync(target, '# AGENTS\n\nManually-written user notes.\n');
    const res = exec.graduate({ candidate: cand, body: 'auto rule', shadow: DEFAULT_SHADOW, skipStateTransition: true });
    expect(hasMarkerBlock(target, res.content_hash)).toBe(true);
    const rb = exec.rollback('general', res.content_hash);
    expect(rb.removed).toBe(true);
    const after = readFileSync(target, 'utf-8');
    expect(after).toContain('# AGENTS');
    expect(after).toContain('Manually-written user notes.');
    expect(after).not.toContain(`graduated:sha256:${res.content_hash}`);
  });

  it('rollback of missing block returns removed=false', () => {
    const exec = mkExecutor();
    const bogus = 'f'.repeat(64);
    expect(exec.rollback('general', bogus).removed).toBe(false);
  });

  it('rollback preserves graduated/<hash>.md body (audit trail)', () => {
    const cand = mkCandidate('general');
    const exec = mkExecutor();
    const res = exec.graduate({ candidate: cand, body: 'keep me', shadow: DEFAULT_SHADOW, skipStateTransition: true });
    exec.rollback('general', res.content_hash);
    expect(existsSync(res.body_path)).toBe(true);       // blob retained
    expect(existsSync(res.record_path)).toBe(true);     // record retained
  });
});

describe('GraduationExecutor: partial_failure_rollback [#93]', () => {
  it('rolls back marker injection when graduation_record write fails', () => {
    const cand = mkCandidate('general');
    const exec = mkExecutor();
    const target = join(tmpRoot, 'AGENTS.md');
    // Sabotage: create a *file* where the graduations *directory* should be,
    // so atomicWrite of the YAML record fails. Marker injection already
    // succeeded by that time and must be rolled back.
    const graduationsDir = join(tmpRoot, 'learn', 'audit', 'graduations');
    mkdirSync(join(tmpRoot, 'learn', 'audit'), { recursive: true });
    writeFileSync(graduationsDir, 'I am a file, not a directory');
    expect(() =>
      exec.graduate({ candidate: cand, body: 'partial-fail', shadow: DEFAULT_SHADOW, skipStateTransition: true }),
    ).toThrow();
    // AGENTS.md should not contain any graduated block — rollback fired
    if (existsSync(target)) {
      const content = readFileSync(target, 'utf-8');
      expect(content).not.toMatch(/graduated:sha256:/);
    }
  });
});

describe('GraduationExecutor: checkpoint_missing_abort [#94]', () => {
  it('aborts when requireCheckpoint=true and no git_commit provided', () => {
    const cand = mkCandidate('general');
    const exec = mkExecutor({ requireCheckpoint: true });
    expect(() =>
      exec.graduate({ candidate: cand, body: 'b', shadow: DEFAULT_SHADOW, skipStateTransition: true }),
    ).toThrow(GraduationCheckpointMissingError);
    // nothing should be written
    const target = join(tmpRoot, 'AGENTS.md');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(tmpRoot, 'learn', 'graduated'))).toBe(false);
  });

  it('accepts when requireCheckpoint=true and git_commit provided', () => {
    const cand = mkCandidate('general');
    const exec = mkExecutor({ requireCheckpoint: true });
    const res = exec.graduate({
      candidate: cand, body: 'b', shadow: DEFAULT_SHADOW,
      rollbackCheckpoint: { git_commit: 'deadbeef' },
      skipStateTransition: true,
    });
    expect(res.record.rollback_checkpoint.git_commit).toBe('deadbeef');
  });
});

describe('GraduationExecutor: readRecord', () => {
  it('reads back a persisted record', () => {
    const cand = mkCandidate('general');
    const exec = mkExecutor();
    const res = exec.graduate({ candidate: cand, body: 'for-read', shadow: DEFAULT_SHADOW, skipStateTransition: true });
    const loaded = exec.readRecord(res.content_hash)!;
    expect(loaded.content_hash).toBe(res.content_hash);
    expect(loaded.scope).toBe('general');
  });

  it('returns null for unknown hash', () => {
    const exec = mkExecutor();
    expect(exec.readRecord('0'.repeat(64))).toBeNull();
  });
});

describe('GraduationExecutor: isolation sentinel', () => {
  it('tmpRoot is always inside os.tmpdir() (real AGENTS.md untouched)', () => {
    expect(tmpRoot.startsWith(tmpdir())).toBe(true);
    expect(tmpRoot).not.toMatch(/openclaw\/workspace\/AGENTS\.md/);
  });
});
