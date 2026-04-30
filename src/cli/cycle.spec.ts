// src/cli/cycle.spec.ts
//
// T-058a · `openclaw-learn cycle` CLI tests.
//
// Focuses on flag parsing + integration with runCycle via injected store.
// (Full e2e in src/orchestrator/cycle.e2e.spec.ts.)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CandidateStore } from '../store/candidate-store.js';
import { TrialCollector } from '../shadow/trial-collector.js';
import { ShadowRunner } from '../shadow/shadow-runner.js';
import { computeStrategyId, computeInstanceId } from '../kernel/content-id.js';
import type {
  EnvFingerprint,
  Instance,
  SessionEvent,
  Strategy,
} from '../kernel/types.js';
import { runCycleCommand } from './cycle.js';

const MIG_DIR = new URL('../store/migrations', import.meta.url).pathname;

let tmpDir: string;
let store: CandidateStore;
let workspace: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cli-cycle-'));
  workspace = join(tmpDir, 'ws');
  mkdirSync(join(workspace, 'learn', 'candidates'), { recursive: true });
  writeFileSync(join(workspace, 'AGENTS.md'), '# AGENTS.md\n', 'utf8');

  store = new CandidateStore({
    dbPath: join(tmpDir, 't.db'),
    migrationsDir: MIG_DIR,
  });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function captureIO() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (s: string) => stdout.push(s),
    stderr: (s: string) => stderr.push(s),
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  };
}

describe('openclaw-learn cycle CLI', () => {
  it('--help prints usage', async () => {
    const io = captureIO();
    const r = await runCycleCommand({
      argv: ['--help'],
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(r.exitCode).toBe(0);
    expect(io.out()).toContain('Usage: openclaw-learn cycle');
    expect(io.out()).toContain('--dry-run');
    expect(io.out()).toContain('--execute');
  });

  it('rejects unknown flags', async () => {
    const io = captureIO();
    const r = await runCycleCommand({
      argv: ['--bogus'],
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(r.exitCode).toBe(2);
    expect(io.err()).toContain('unknown argument');
  });

  it('rejects invalid --since', async () => {
    const io = captureIO();
    const r = await runCycleCommand({
      argv: ['--since', 'not-a-date'],
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(r.exitCode).toBe(2);
    expect(io.err()).toContain('invalid --since');
  });

  it('rejects invalid --format', async () => {
    const io = captureIO();
    const r = await runCycleCommand({
      argv: ['--format', 'xml'],
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(r.exitCode).toBe(2);
    expect(io.err()).toContain('--format must be');
  });

  it('runs dry-run with empty workspace (no candidates) and emits report', async () => {
    process.env.LEARNING_LOOP_WORKSPACE = workspace;
    const io = captureIO();
    const r = await runCycleCommand({
      argv: ['--dry-run', '--runtime', 'nonexistent', '--format', 'json'],
      cwd: workspace,
      stdout: io.stdout,
      stderr: io.stderr,
      store,
      candidatesDir: join(workspace, 'learn', 'candidates'),
    });
    delete process.env.LEARNING_LOOP_WORKSPACE;

    expect(r.exitCode).toBe(0);
    expect(r.report).toBeDefined();
    expect(r.report?.dryRun).toBe(true);
    expect(r.report?.candidates).toEqual([]);
    // unknown runtime → recorded in errors
    expect(r.report?.errors.some((e) => e.runtime === 'nonexistent')).toBe(true);
    // JSON output
    const out = io.out();
    expect(out).toContain('"dryRun": true');
  });

  it('table format renders sessions/candidates/errors sections', async () => {
    process.env.LEARNING_LOOP_WORKSPACE = workspace;
    const io = captureIO();
    const r = await runCycleCommand({
      argv: ['--runtime', 'nope'],
      cwd: workspace,
      stdout: io.stdout,
      stderr: io.stderr,
      store,
      candidatesDir: join(workspace, 'learn', 'candidates'),
    });
    delete process.env.LEARNING_LOOP_WORKSPACE;

    expect(r.exitCode).toBe(0);
    const out = io.out();
    expect(out).toContain('cycle [DRY-RUN]');
    expect(out).toContain('Sessions observed: 0');
    expect(out).toContain('Candidates evaluated: 0');
    expect(out).toContain('Errors:');
  });

  it('--help advertises --mock-phase1a with explicit safety warning', async () => {
    const io = captureIO();
    const r = await runCycleCommand({
      argv: ['--help'],
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out();
    expect(out).toContain('--mock-phase1a');
    expect(out).toContain('WARNING');
    expect(out).toMatch(/cron|automation/i);
  });

  // T-058c-Lite/B1 · explicit-opt-in flag gate.
  // Pre-seed a validating candidate + 5 raw trials (assertions=[], completion=0).
  // Without --mock-phase1a, the cycle's own collector returns the raw shape and
  // no baselineProvider is injected → candidate must NOT graduate.
  // With --mock-phase1a, the same store reaches the truth-table row #2 path →
  // candidate graduates (matches the path 9178ff4 originally hard-wired).
  describe('--mock-phase1a flag gate', () => {
    const ENV: EnvFingerprint = {
      runtime: 'openclaw',
      platform: 'linux',
      arch: 'x64',
      model: 'claude-opus-4.7',
    };

    function mkEvent(
      type: SessionEvent['type'],
      content: string,
      metadata: Record<string, unknown> = {},
    ): SessionEvent {
      return { type, timestamp: new Date(), content, metadata };
    }

    function seedValidatingCandidateWithTrials(): string {
      const baseStrategy = {
        problem_category: 'tmp_cleanup_flag_gate',
        trigger_conditions: 'temporary files in /tmp accumulate after subagents',
        recommended_action: 'rm -f /tmp/leftover-*',
      };
      const strategy: Strategy = {
        ...baseStrategy,
        strategy_id: computeStrategyId(baseStrategy),
        scope: 'general',
        summary: 'flag-gate test candidate',
        created_at: new Date().toISOString(),
        instance_ids: [],
      };
      const baseInstance = {
        strategy_id: strategy.strategy_id,
        diff_summary: 'add cleanup',
        env_fingerprint: ENV,
      };
      const instance: Instance = {
        ...baseInstance,
        instance_id: computeInstanceId(baseInstance),
        files_touched: ['AGENTS.md'],
        source_sessions: [
          { session_id: 's-orig', runtime: 'openclaw', timestamp: new Date().toISOString() },
        ],
        assertions: [
          { type: 'command_exit_code', command: 'true', expected_exit_code: 0 },
          { type: 'regex_match', description: 'check' },
        ],
        trial_results: [],
        created_at: new Date().toISOString(),
      };
      store.create({ strategy, instances: [instance], initialState: 'pending' });
      store.transition(strategy.strategy_id, 'pending', 'reviewing', 'start_review');
      store.transition(strategy.strategy_id, 'reviewing', 'validating', 'review_passed');

      // Seed 5 raw trials via a *plain* (non-mock) collector so that what's in
      // the DB is exactly what production would write today (assertions=[],
      // completion_rate=0). The cycle-under-test will reread these via its OWN
      // collector — the projection (or lack thereof) is what we're verifying.
      const seedCollector = new TrialCollector({ store, batchSize: 1 });
      const seedRunner = new ShadowRunner({ store, collector: seedCollector });
      for (let i = 0; i < 5; i++) {
        const events: SessionEvent[] = [
          mkEvent('user_message', `please clean up the temporary files in /tmp/leftover-${i}`),
          mkEvent('tool_call', `ls /tmp/leftover-${i}`, { tool_name: 'exec' }),
          mkEvent(
            'tool_result',
            `found 3 temporary files in /tmp/leftover-${i}, ready for cleanup with rm`,
          ),
        ];
        seedRunner.observe(`seed-sess-${i}`, events, ENV);
      }
      seedCollector.flush();
      return strategy.strategy_id;
    }

    it('default (mock OFF): pre-seeded candidate is NOT graduated', async () => {
      const sid = seedValidatingCandidateWithTrials();
      process.env.LEARNING_LOOP_WORKSPACE = workspace;
      const io = captureIO();
      const r = await runCycleCommand({
        argv: ['--runtime', 'nonexistent', '--format', 'json'],
        cwd: workspace,
        stdout: io.stdout,
        stderr: io.stderr,
        store,
        candidatesDir: join(workspace, 'learn', 'candidates'),
        // Note: NOT passing mockPhase1a, NOT passing --mock-phase1a flag.
      });
      delete process.env.LEARNING_LOOP_WORKSPACE;

      expect(r.exitCode).toBe(0);
      const c = store.get(sid);
      // Must not silently graduate when the safety flag is absent.
      expect(c?.state).not.toBe('graduated');
      // Sanity: report contains an evaluated entry but its outcome is not 'graduated'.
      const evaluated = r.report?.candidates.find((x) => x.candidate_id === sid);
      if (evaluated) {
        expect(evaluated.outcome.status).not.toBe('graduated');
      }
    });

    it('--mock-phase1a flag flips graduation back ON for the same fixture', async () => {
      const sid = seedValidatingCandidateWithTrials();
      process.env.LEARNING_LOOP_WORKSPACE = workspace;
      const io = captureIO();
      const r = await runCycleCommand({
        argv: ['--runtime', 'nonexistent', '--mock-phase1a', '--format', 'json'],
        cwd: workspace,
        stdout: io.stdout,
        stderr: io.stderr,
        store,
        candidatesDir: join(workspace, 'learn', 'candidates'),
      });
      delete process.env.LEARNING_LOOP_WORKSPACE;

      expect(r.exitCode).toBe(0);
      const evaluated = r.report?.candidates.find((x) => x.candidate_id === sid);
      expect(evaluated?.outcome.status).toBe('graduated');
    });

    it('programmatic mockPhase1a:true bypasses CLI flag (test injection point)', async () => {
      const sid = seedValidatingCandidateWithTrials();
      process.env.LEARNING_LOOP_WORKSPACE = workspace;
      const io = captureIO();
      const r = await runCycleCommand({
        argv: ['--runtime', 'nonexistent', '--format', 'json'],
        cwd: workspace,
        stdout: io.stdout,
        stderr: io.stderr,
        store,
        candidatesDir: join(workspace, 'learn', 'candidates'),
        mockPhase1a: true,
      });
      delete process.env.LEARNING_LOOP_WORKSPACE;

      expect(r.exitCode).toBe(0);
      const evaluated = r.report?.candidates.find((x) => x.candidate_id === sid);
      expect(evaluated?.outcome.status).toBe('graduated');
    });
  });
});
