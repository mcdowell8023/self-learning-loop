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
});
