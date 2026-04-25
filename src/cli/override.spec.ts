// src/cli/override.spec.ts
//
// T-P1a-009 tests for the Override CLI (force-graduate / force-retire).
//
// Covers:
//   - Argv parsing (reason required, non-empty, flag forms)
//   - Legal #12 transitions from each allowed source state
//   - Legal #13 transitions from each allowed source state
//   - Illegal #12 from {graduated, rejected}
//   - Illegal #13 from {retired, rejected}
//   - DB path missing
//   - Candidate id missing
//   - Audit JSONL completeness (action / reason / timestamp / candidate_id / from/to)
//   - force-graduate on validating writes AGENTS.md marker block
//   - force-graduate on non-validating skips artifact write but still transitions
//   - Isolation: uses tmpdir, never touches real ~/.openclaw/workspace/AGENTS.md

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { runOverride, parseArgs } from './override.js';
import {
  openCandidateStore,
  type CandidateStore,
} from '../store/candidate-store.js';
import type {
  Candidate,
  CandidateScope,
  CandidateState,
  Instance,
  Strategy,
  DormantReason,
} from '../kernel/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpRoot: string;
let dbPath: string;
let store: CandidateStore;
let stdoutBuf: string[];
let stderrBuf: string[];

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function mkStrategy(
  scope: CandidateScope = 'general',
  id?: string,
): Strategy {
  const sid = id ?? sha(`s-${Math.random()}-${Date.now()}`);
  return {
    strategy_id: sid,
    problem_category: 'cat',
    trigger_conditions: 'cond',
    recommended_action: 'act',
    scope,
    tags: [],
    created_at: new Date().toISOString(),
    instance_ids: [sid + '-i'],
  };
}

function mkInstance(strategyId: string): Instance {
  return {
    instance_id: strategyId + '-i',
    strategy_id: strategyId,
    diff_summary: 'd',
    files_touched: ['a.ts'],
    env_fingerprint: { runtime: 'openclaw', platform: 'linux', arch: 'x64' },
    source_sessions: [
      { session_id: 's1', runtime: 'openclaw', timestamp: new Date().toISOString() },
    ],
    assertions: [],
    trial_results: [],
    created_at: new Date().toISOString(),
  };
}

/** Insert candidate + drive state machine to reach a target state. */
function seedCandidate(
  state: CandidateState,
  opts: { dormantReason?: DormantReason } = {},
): Candidate {
  const strategy = mkStrategy();
  const instance = mkInstance(strategy.strategy_id);
  store.create({ strategy, instances: [instance] });

  switch (state) {
    case 'pending':
      break;
    case 'reviewing':
      store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
      break;
    case 'validating':
      store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
      store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');
      break;
    case 'conflict':
      store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
      store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');
      store.transition(strategy.strategy_id, 'validating', 'conflict', 'enter_conflict');
      break;
    case 'dormant': {
      store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
      store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');
      store.transition(strategy.strategy_id, 'validating', 'dormant', 'enter_dormant', {
        dormantReason: opts.dormantReason ?? 'no_match',
      });
      break;
    }
    case 'graduated':
      store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
      store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');
      store.transition(strategy.strategy_id, 'validating', 'graduated', 'graduate');
      break;
    case 'retired':
      store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
      store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');
      store.transition(strategy.strategy_id, 'validating', 'retired', 'retire');
      break;
    case 'rejected':
      store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
      store.transition(strategy.strategy_id, 'reviewing', 'rejected', 'review_failed');
      break;
  }
  return store.get(strategy.strategy_id)!;
}

const runnerOpts = () => ({
  cwd: tmpRoot,
  store,
  stdout: (s: string) => stdoutBuf.push(s),
  stderr: (s: string) => stderrBuf.push(s),
  now: () => new Date('2026-04-22T02:55:00.000Z'),
  uuid: () => 'aud-uuid-1',
});

const readAudit = (): Array<Record<string, unknown>> => {
  const p = join(tmpRoot, 'learn', 'audit', 'overrides.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((ln) => JSON.parse(ln));
};

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'override-cli-'));
  dbPath = join(tmpRoot, 'learn', 'candidates.db');
  store = openCandidateStore({ dbPath, defaultActor: 'system' });
  stdoutBuf = [];
  stderrBuf = [];
  process.env.LEARNING_LOOP_WORKSPACE = tmpRoot;
});

afterEach(() => {
  delete process.env.LEARNING_LOOP_WORKSPACE;
  try { store.close(); } catch { /* ignore */ }
  if (tmpRoot && existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ===========================================================================
// parseArgs
// ===========================================================================

describe('parseArgs', () => {
  it('rejects missing command', () => {
    const r = parseArgs([]);
    expect(r.kind).toBe('error');
  });

  it('rejects unknown command', () => {
    const r = parseArgs(['force-delete', 'abc', '--reason', 'x']);
    expect(r.kind).toBe('error');
  });

  it('requires --reason (missing → error)', () => {
    const r = parseArgs(['force-graduate', 'cand-1']);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/--reason/);
  });

  it('rejects empty --reason', () => {
    const r = parseArgs(['force-retire', 'c', '--reason', '   ']);
    expect(r.kind).toBe('error');
  });

  it('accepts --reason=value form', () => {
    const r = parseArgs(['force-retire', 'c', '--reason=bad-signal']);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.reason).toBe('bad-signal');
      expect(r.candidateId).toBe('c');
    }
  });

  it('collects --db and --workspace flags', () => {
    const r = parseArgs([
      'force-graduate', 'cand-x',
      '--reason', 'manual approval',
      '--db', '/tmp/a.db',
      '--workspace', '/tmp/ws',
    ]);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.dbFlag).toBe('/tmp/a.db');
      expect(r.workspaceFlag).toBe('/tmp/ws');
    }
  });

  it('rejects missing candidate id', () => {
    const r = parseArgs(['force-graduate', '--reason', 'x']);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toMatch(/candidate_id/);
  });

  it('returns help on -h', () => {
    const r = parseArgs(['-h']);
    expect(r.kind).toBe('help');
  });
});

// ===========================================================================
// force-graduate: legal transitions per rule #12
// ===========================================================================

describe('runOverride: force-graduate legal #12', () => {
  it('graduates a pending candidate (skips artifact write)', async () => {
    const c = seedCandidate('pending');
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-graduate', c.candidate_id, '--reason', 'ops override'],
    });
    expect(res.exitCode).toBe(0);
    expect(res.wroteArtifact).toBe(false);
    expect(store.get(c.candidate_id)!.state).toBe('graduated');
  });

  it('graduates a reviewing candidate', async () => {
    const c = seedCandidate('reviewing');
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-graduate', c.candidate_id, '--reason', 'urgent'],
    });
    expect(res.exitCode).toBe(0);
    expect(store.get(c.candidate_id)!.state).toBe('graduated');
  });

  it('graduates a dormant candidate without needing dormant_reason match', async () => {
    const c = seedCandidate('dormant', { dormantReason: 'no_match' });
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-graduate', c.candidate_id, '--reason', 'revive'],
    });
    expect(res.exitCode).toBe(0);
    expect(store.get(c.candidate_id)!.state).toBe('graduated');
  });

  it('graduates a conflict candidate', async () => {
    const c = seedCandidate('conflict');
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-graduate', c.candidate_id, '--reason', 'pick-winner'],
    });
    expect(res.exitCode).toBe(0);
    expect(store.get(c.candidate_id)!.state).toBe('graduated');
  });

  it('graduates a validating candidate AND writes AGENTS.md artifact', async () => {
    const c = seedCandidate('validating');
    const res = await runOverride({
      ...runnerOpts(),
      defaultBody: '## Override Rule\n\nForce-graduated by test.\n',
      argv: ['force-graduate', c.candidate_id, '--reason', 'passed review manually'],
    });
    expect(res.exitCode).toBe(0);
    expect(res.wroteArtifact).toBe(true);
    expect(res.targetFile).toBe(join(tmpRoot, 'AGENTS.md'));
    const agents = readFileSync(res.targetFile!, 'utf-8');
    expect(agents).toMatch(/graduated:sha256:/);
    expect(agents).toContain('Force-graduated by test');
    expect(store.get(c.candidate_id)!.state).toBe('graduated');
  });
});

// ===========================================================================
// force-graduate: illegal #12
// ===========================================================================

describe('runOverride: force-graduate illegal #12', () => {
  it('loud rejects force-graduate on already-graduated candidate', async () => {
    const c = seedCandidate('graduated');
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-graduate', c.candidate_id, '--reason', 'oops'],
    });
    expect(res.exitCode).not.toBe(0);
    expect(stderrBuf.join('')).toMatch(/illegal override/);
    // State unchanged.
    expect(store.get(c.candidate_id)!.state).toBe('graduated');
    // No audit event written for rejected override.
    expect(readAudit()).toHaveLength(0);
  });

  it('loud rejects force-graduate on rejected candidate', async () => {
    const c = seedCandidate('rejected');
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-graduate', c.candidate_id, '--reason', 'nope'],
    });
    expect(res.exitCode).not.toBe(0);
    expect(store.get(c.candidate_id)!.state).toBe('rejected');
  });
});

// ===========================================================================
// force-retire: legal #13 + illegal
// ===========================================================================

describe('runOverride: force-retire #13', () => {
  it('retires a pending candidate', async () => {
    const c = seedCandidate('pending');
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-retire', c.candidate_id, '--reason', 'abandon'],
    });
    expect(res.exitCode).toBe(0);
    expect(store.get(c.candidate_id)!.state).toBe('retired');
  });

  it('retires a graduated candidate (rule #13 allows graduated → retired)', async () => {
    const c = seedCandidate('graduated');
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-retire', c.candidate_id, '--reason', 'superseded'],
    });
    expect(res.exitCode).toBe(0);
    expect(store.get(c.candidate_id)!.state).toBe('retired');
  });

  it('retires a dormant candidate', async () => {
    const c = seedCandidate('dormant', { dormantReason: 'inconclusive' });
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-retire', c.candidate_id, '--reason', 'ttl-manual'],
    });
    expect(res.exitCode).toBe(0);
    expect(store.get(c.candidate_id)!.state).toBe('retired');
  });

  it('loud rejects force-retire on already-retired candidate', async () => {
    const c = seedCandidate('retired');
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-retire', c.candidate_id, '--reason', 'dup'],
    });
    expect(res.exitCode).not.toBe(0);
    expect(stderrBuf.join('')).toMatch(/illegal override/);
  });

  it('loud rejects force-retire on rejected candidate', async () => {
    const c = seedCandidate('rejected');
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-retire', c.candidate_id, '--reason', 'again'],
    });
    expect(res.exitCode).not.toBe(0);
  });
});

// ===========================================================================
// error cases
// ===========================================================================

describe('runOverride: error cases', () => {
  it('returns exit=2 if db file not found (no --store override)', async () => {
    const missingDb = join(tmpRoot, 'nope', 'missing.db');
    const res = await runOverride({
      cwd: tmpRoot,
      stdout: (s) => stdoutBuf.push(s),
      stderr: (s) => stderrBuf.push(s),
      argv: ['force-retire', 'x', '--reason', 'r', '--db', missingDb],
    });
    expect(res.exitCode).toBe(2);
    expect(stderrBuf.join('')).toMatch(/not found/);
  });

  it('returns exit=3 if candidate id is unknown', async () => {
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-graduate', 'does-not-exist', '--reason', 'r'],
    });
    expect(res.exitCode).toBe(3);
    expect(stderrBuf.join('')).toMatch(/candidate not found/);
  });

  it('exits non-zero when --reason missing', async () => {
    const res = await runOverride({
      ...runnerOpts(),
      argv: ['force-graduate', 'any-id'],
    });
    expect(res.exitCode).not.toBe(0);
    expect(stderrBuf.join('')).toMatch(/--reason/);
  });
});

// ===========================================================================
// audit trail
// ===========================================================================

describe('runOverride: audit trail', () => {
  it('appends JSONL audit event with full metadata', async () => {
    const c = seedCandidate('pending');
    await runOverride({
      ...runnerOpts(),
      argv: ['force-graduate', c.candidate_id, '--reason', 'approved by ops'],
    });
    const events = readAudit();
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.event_id).toBe('aud-uuid-1');
    expect(e.type).toBe('candidate_override');
    expect(e.timestamp).toBe('2026-04-22T02:55:00.000Z');
    expect(e.candidate_id).toBe(c.candidate_id);
    expect(e.actor).toBe('user');
    const data = e.data as Record<string, unknown>;
    expect(data.action).toBe('force_graduate');
    expect(data.from_state).toBe('pending');
    expect(data.to_state).toBe('graduated');
    expect(data.reason).toBe('approved by ops');
  });

  it('records force_retire action separately', async () => {
    const c = seedCandidate('validating');
    await runOverride({
      ...runnerOpts(),
      argv: ['force-retire', c.candidate_id, '--reason', 'bad results'],
    });
    const events = readAudit();
    expect(events).toHaveLength(1);
    expect((events[0]!.data as Record<string, unknown>).action).toBe('force_retire');
  });

  it('appends multiple events across invocations', async () => {
    const c1 = seedCandidate('pending');
    const c2 = seedCandidate('reviewing');
    await runOverride({
      ...runnerOpts(),
      uuid: () => 'aud-1',
      argv: ['force-graduate', c1.candidate_id, '--reason', 'r1'],
    });
    await runOverride({
      ...runnerOpts(),
      uuid: () => 'aud-2',
      argv: ['force-retire', c2.candidate_id, '--reason', 'r2'],
    });
    const events = readAudit();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.event_id)).toEqual(['aud-1', 'aud-2']);
  });

  it('isolation: does not touch real ~/.openclaw workspace', () => {
    expect(tmpRoot.startsWith(tmpdir())).toBe(true);
    const realAgents = join(process.env.HOME ?? '~', '.openclaw', 'workspace', 'AGENTS.md');
    expect(realAgents).not.toBe(join(tmpRoot, 'AGENTS.md'));
  });

  // === revert tests ===

  it('revert: reverts graduated candidate to validating', async () => {
    const c = seedCandidate('graduated');
    const r = await runOverride({
      ...runnerOpts(),
      argv: ['revert', c.candidate_id, '--reason', 'testing revert'],
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('graduation_reverted');
    expect(r.toState).toBe('validating');
    // Verify via a fresh store read
    const fresh = store.get(c.candidate_id);
    expect(fresh?.state).toBe('validating');
  });

  it('revert: rejects non-graduated candidate', async () => {
    const c = seedCandidate('pending');
    const r = await runOverride({
      ...runnerOpts(),
      argv: ['revert', c.candidate_id, '--reason', 'should fail'],
    });
    expect(r.exitCode).toBe(4);
    expect(r.message).toContain('revert only works on graduated');
  });
});
