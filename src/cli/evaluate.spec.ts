import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

vi.mock('../store/candidate-mirror.js', async () => {
  const actual = await vi.importActual<typeof import('../store/candidate-mirror.js')>(
    '../store/candidate-mirror.js',
  );
  return {
    ...actual,
    writeMirror: vi.fn(actual.writeMirror),
  };
});

import { runEvaluate, runEvaluateAll } from './evaluate.js';
import { ReviewGate } from '../review/review-gate.js';
import { writeMirror } from '../store/candidate-mirror.js';
import type { Candidate, Instance, Strategy } from '../kernel/types.js';
import type { ReviewResult } from '../review/types.js';

type FakeStore = {
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  transition: ReturnType<typeof vi.fn>;
  getTransitions: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  __seed: (candidate: Candidate) => void;
  __candidate: (id: string) => Candidate | null;
};

let tmpRoot: string;
let candidatesDir: string;
let stdoutBuf: string[];
let stderrBuf: string[];

const out = (s: string) => stdoutBuf.push(s);
const err = (s: string) => stderrBuf.push(s);
const stdoutStr = () => stdoutBuf.join('');
const stderrStr = () => stderrBuf.join('');

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'evaluate-cli-'));
  candidatesDir = join(tmpRoot, 'candidates');
  stdoutBuf = [];
  stderrBuf = [];
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sha(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function mkStrategy(overrides: Partial<Strategy> = {}): Strategy {
  const problem_category = overrides.problem_category ?? 'candidate evaluation smoke';
  const trigger_conditions =
    overrides.trigger_conditions ?? 'when the same issue appears repeatedly in sessions';
  const recommended_action =
    overrides.recommended_action ??
    'add a repeatable evaluation command and verify it against isolated workspace data';
  const strategy_id =
    overrides.strategy_id ?? sha(`${problem_category}|${trigger_conditions}|${recommended_action}`);

  return {
    strategy_id,
    problem_category,
    trigger_conditions,
    recommended_action,
    scope: overrides.scope ?? 'general',
    tags: overrides.tags ?? ['eval'],
    created_at: overrides.created_at ?? new Date().toISOString(),
    instance_ids: overrides.instance_ids ?? [strategy_id + '-i'],
    summary: overrides.summary,
    trigger_event: overrides.trigger_event,
  };
}

function mkInstance(strategyId: string, overrides: Partial<Instance> = {}): Instance {
  return {
    instance_id: overrides.instance_id ?? `${strategyId}-i`,
    strategy_id: strategyId,
    diff_summary: overrides.diff_summary ?? 'implemented evaluate command',
    files_touched: overrides.files_touched ?? ['src/cli/evaluate.ts'],
    env_fingerprint:
      overrides.env_fingerprint ?? { runtime: 'openclaw', platform: 'linux', arch: 'x64' },
    source_sessions:
      overrides.source_sessions ?? [
        { session_id: 'session-1', runtime: 'openclaw', timestamp: new Date().toISOString() },
      ],
    assertions: overrides.assertions ?? [],
    trial_results: overrides.trial_results ?? [],
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

function mkCandidate(overrides: { strategy?: Partial<Strategy>; state?: Candidate['state'] } = {}): Candidate {
  const strategy = mkStrategy(overrides.strategy);
  return {
    candidate_id: strategy.strategy_id,
    strategy,
    instances: [mkInstance(strategy.strategy_id)],
    state: overrides.state ?? 'pending',
    dormant_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeStore(initial: Candidate[] = []): FakeStore {
  const data = new Map(initial.map((c) => [c.candidate_id, structuredClone(c)]));
  const transitions = new Map<string, Array<{ from_state: string; to_state: string; action: string; actor: string; dormant_reason: null; transitioned_at: string }>>();

  for (const candidate of initial) {
    transitions.set(candidate.candidate_id, [
      {
        from_state: 'pending',
        to_state: 'pending',
        action: 'create',
        actor: 'system',
        dormant_reason: null,
        transitioned_at: candidate.created_at,
      },
    ]);
  }

  const store: FakeStore = {
    get: vi.fn((id: string) => {
      const value = data.get(id);
      return value ? structuredClone(value) : null;
    }),
    list: vi.fn((opts?: { state?: string | string[] }) => {
      const rows = [...data.values()].map((c) => structuredClone(c));
      if (!opts?.state) return rows;
      const wanted = Array.isArray(opts.state) ? opts.state : [opts.state];
      return rows.filter((row) => wanted.includes(row.state));
    }),
    transition: vi.fn((id: string, _from: string, to: Candidate['state'], action: string) => {
      const current = data.get(id);
      if (!current) throw new Error(`candidate not found: ${id}`);
      const next = {
        ...current,
        state: to,
        updated_at: new Date().toISOString(),
      } satisfies Candidate;
      data.set(id, next);
      const history = transitions.get(id) ?? [];
      history.push({
        from_state: current.state,
        to_state: to,
        action,
        actor: 'system',
        dormant_reason: null,
        transitioned_at: next.updated_at,
      });
      transitions.set(id, history);
      return structuredClone(next);
    }),
    getTransitions: vi.fn((id: string) => structuredClone(transitions.get(id) ?? [])),
    close: vi.fn(),
    __seed: (candidate: Candidate) => {
      data.set(candidate.candidate_id, structuredClone(candidate));
      transitions.set(candidate.candidate_id, [
        {
          from_state: 'pending',
          to_state: candidate.state,
          action: 'create',
          actor: 'system',
          dormant_reason: null,
          transitioned_at: candidate.created_at,
        },
      ]);
    },
    __candidate: (id: string) => {
      const value = data.get(id);
      return value ? structuredClone(value) : null;
    },
  };

  return store;
}

function mockReviewImplementation() {
  return vi.spyOn(ReviewGate.prototype, 'review').mockImplementation(async function (candidate: Candidate) {
    const fail = candidate.strategy.recommended_action === 'fix';
    const final_state = fail ? 'rejected' : 'validating';
    const failed_at = fail ? 'semantic' : undefined;

    const backingStore = this.store as Pick<FakeStore, 'transition'>;
    backingStore.transition(
      candidate.candidate_id,
      candidate.state,
      candidate.state === 'pending' ? 'reviewing' : candidate.state,
      'start_review',
    );
    backingStore.transition(
      candidate.candidate_id,
      'reviewing',
      final_state,
      fail ? 'review_failed' : 'review_passed',
    );

    const result: ReviewResult = {
      candidate_id: candidate.candidate_id,
      pass: !fail,
      ...(failed_at ? { failed_at } : {}),
      dimensions: fail
        ? [
            { dimension: 'metadata', pass: true, salvageable: false },
            { dimension: 'safety', pass: true, salvageable: false },
            {
              dimension: 'semantic',
              pass: false,
              salvageable: true,
              code: 'LOW_QUALITY',
              reason: 'recommended action too short',
            },
          ]
        : [
            { dimension: 'metadata', pass: true, salvageable: false },
            { dimension: 'safety', pass: true, salvageable: false },
            { dimension: 'conflict', pass: true, salvageable: false },
            { dimension: 'semantic', pass: true, salvageable: false },
          ],
      reviewed_by: 'cli/evaluate-test',
      reviewed_at: new Date().toISOString(),
      final_state,
      audit_log: [],
    };

    return result;
  });
}

describe('evaluate CLI', () => {
  it('dry-run does not mutate store and does not write mirror', async () => {
    const candidate = mkCandidate();
    const store = makeStore([candidate]);
    mockReviewImplementation();

    const r = await runEvaluate({
      argv: [candidate.candidate_id, '--dry-run'],
      cwd: tmpRoot,
      store: store as any,
      candidatesDir,
      stdout: out,
      stderr: err,
    });

    expect(r.exitCode).toBe(0);
    expect(store.transition).not.toHaveBeenCalled();
    expect(vi.mocked(writeMirror)).not.toHaveBeenCalled();
    expect(store.__candidate(candidate.candidate_id)?.state).toBe('pending');
    expect(r.rows).toHaveLength(1);
    expect(r.rows?.[0]?.next_state).toBe('validating');
    expect(r.summary?.dry_run).toBe(true);
  });

  it('execute mode calls ReviewGate.review and drives transition via gate internals', async () => {
    const candidate = mkCandidate();
    const store = makeStore([candidate]);
    const reviewSpy = mockReviewImplementation();

    const r = await runEvaluate({
      argv: [candidate.candidate_id, '--execute'],
      cwd: tmpRoot,
      store: store as any,
      candidatesDir,
      stdout: out,
      stderr: err,
    });

    expect(r.exitCode).toBe(0);
    expect(reviewSpy).toHaveBeenCalledTimes(1);
    expect(store.__candidate(candidate.candidate_id)?.state).toBe('validating');
    expect(store.transition).toHaveBeenCalledTimes(2);
    expect(store.getTransitions(candidate.candidate_id).map((t: any) => t.to_state)).toEqual([
      'pending',
      'reviewing',
      'validating',
    ]);
    expect(vi.mocked(writeMirror)).toHaveBeenCalledTimes(1);
    const mirrorPath = vi.mocked(writeMirror).mock.results[0]?.value as string;
    expect(existsSync(mirrorPath)).toBe(true);
    const mirror = readFileSync(mirrorPath, 'utf-8');
    expect(mirror).toContain('last_evaluated_at:');
    expect(mirror).toContain('evaluation_result:');
    expect(mirror).toContain('pass: true');
    expect(mirror).toContain('final_state: validating');
  });

  it('parses single evaluate <id> correctly', async () => {
    const candidate = mkCandidate();
    const store = makeStore([candidate]);
    mockReviewImplementation();

    const r = await runEvaluate({
      argv: [candidate.candidate_id, '--format=json'],
      cwd: tmpRoot,
      store: store as any,
      candidatesDir,
      stdout: out,
      stderr: err,
    });

    expect(r.exitCode).toBe(0);
    expect(r.rows).toHaveLength(1);
    expect(r.rows?.[0]?.candidate_id).toBe(candidate.candidate_id);
    expect(JSON.parse(stdoutStr()).rows[0].candidate_id).toBe(candidate.candidate_id);
  });

  it('evaluate-all scans only pending candidates', async () => {
    const pendingA = mkCandidate({ strategy: { problem_category: 'pending A' } });
    const pendingB = mkCandidate({ strategy: { problem_category: 'pending B' } });
    const reviewing = mkCandidate({ strategy: { problem_category: 'reviewing only' }, state: 'reviewing' });
    const store = makeStore([pendingA, pendingB, reviewing]);
    mockReviewImplementation();

    const r = await runEvaluateAll({
      argv: ['--dry-run'],
      cwd: tmpRoot,
      store: store as any,
      candidatesDir,
      stdout: out,
      stderr: err,
    });

    expect(r.exitCode).toBe(0);
    expect(r.rows?.map((row) => row.candidate_id)).toEqual([pendingA.candidate_id, pendingB.candidate_id]);
    expect(r.rows?.some((row) => row.candidate_id === reviewing.candidate_id)).toBe(false);
    expect(r.summary?.total).toBe(2);
  });

  it('table output follows 5-column spec and summary includes totals/final states/avg duration', async () => {
    const store = makeStore([
      mkCandidate({ strategy: { problem_category: 'good candidate title' } }),
      mkCandidate({
        strategy: {
          problem_category: 'bad candidate title',
          recommended_action: 'fix',
        },
      }),
    ]);
    mockReviewImplementation();

    const r = await runEvaluateAll({
      argv: ['--dry-run', '--format=table'],
      cwd: tmpRoot,
      store: store as any,
      candidatesDir,
      stdout: out,
      stderr: err,
    });

    const output = stdoutStr();
    expect(r.exitCode).toBe(0);
    expect(output).toContain('候选 ID');
    expect(output).toContain('标题');
    expect(output).toContain('当前状态');
    expect(output).toContain('→ 目标状态');
    expect(output).toContain('主因');
    expect(output).toContain('总候选数:');
    expect(output).toContain('→ validating: 1');
    expect(output).toContain('→ rejected: 1');
    expect(output).toContain('平均处理时长:');
  });

  it('missing candidate/store.get() null does not crash', async () => {
    const store = makeStore([]);
    mockReviewImplementation();

    const r = await runEvaluate({
      argv: ['does-not-exist'],
      cwd: tmpRoot,
      store: store as any,
      candidatesDir,
      stdout: out,
      stderr: err,
    });

    expect(r.exitCode).toBe(3);
    expect(stderrStr()).toContain('candidate not found');
  });

  it('ReviewResult fields are surfaced correctly for rejected case', async () => {
    const candidate = mkCandidate({
      strategy: {
        problem_category: 'reject me',
        recommended_action: 'fix',
      },
    });
    const store = makeStore([candidate]);
    mockReviewImplementation();

    const r = await runEvaluate({
      argv: [candidate.candidate_id, '--execute', '--format=json'],
      cwd: tmpRoot,
      store: store as any,
      candidatesDir,
      stdout: out,
      stderr: err,
    });

    expect(r.exitCode).toBe(0);
    expect(r.rows?.[0]?.next_state).toBe('rejected');
    expect(r.rows?.[0]?.reason).toContain('semantic');

    const mirrorPath = vi.mocked(writeMirror).mock.results[0]?.value as string;
    const mirror = readFileSync(mirrorPath, 'utf-8');
    expect(mirror).toContain('pass: false');
    expect(mirror).toContain('final_state: rejected');
    expect(mirror).toContain('failed_at: semantic');
  });
});
