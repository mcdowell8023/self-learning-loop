// src/cli/audit.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runAudit } from './audit.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

function capture() {
  let out = '';
  let err = '';
  return {
    stdout: (s: string) => { out += s; },
    stderr: (s: string) => { err += s; },
    out: () => out,
    err: () => err,
  };
}

describe('audit CLI', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `audit-test-${randomUUID()}`);
    mkdirSync(join(tempDir, 'learn', 'audit'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('shows help with no args', async () => {
    const c = capture();
    const r = await runAudit({ argv: [], cwd: tempDir, stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('audit');
    expect(c.out()).toContain('list');
    expect(c.out()).toContain('replay');
    expect(c.out()).toContain('stats');
  });

  it('audit list with empty audit dir', async () => {
    const c = capture();
    const r = await runAudit({ argv: ['list'], cwd: tempDir, stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('No audit events');
  });

  it('audit list shows events', async () => {
    const event = {
      event_id: 'evt-001',
      type: 'candidate_override',
      timestamp: new Date().toISOString(),
      actor: 'user',
      candidate_id: 'cand-001',
      summary: 'force_graduate cand-001',
    };
    writeFileSync(
      join(tempDir, 'learn', 'audit', 'overrides.jsonl'),
      JSON.stringify(event) + '\n',
    );

    const c = capture();
    const r = await runAudit({ argv: ['list'], cwd: tempDir, stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('evt-001');
    expect(c.out()).toContain('candidate_override');
  });

  it('audit replay finds event', async () => {
    const event = {
      event_id: 'evt-002',
      type: 'candidate_override',
      timestamp: new Date().toISOString(),
      actor: 'user',
      data: { action: 'force_graduate', reason: 'testing' },
    };
    writeFileSync(
      join(tempDir, 'learn', 'audit', 'overrides.jsonl'),
      JSON.stringify(event) + '\n',
    );

    const c = capture();
    const r = await runAudit({ argv: ['replay', 'evt-002'], cwd: tempDir, stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('evt-002');
    expect(c.out()).toContain('force_graduate');
  });

  it('audit replay not found', async () => {
    const c = capture();
    const r = await runAudit({ argv: ['replay', 'nonexistent'], cwd: tempDir, stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(3);
    expect(c.err()).toContain('not found');
  });

  it('audit stats with events', async () => {
    const events = [
      { event_id: 'e1', type: 'candidate_override', timestamp: new Date().toISOString(), actor: 'user' },
      { event_id: 'e2', type: 'candidate_override', timestamp: new Date().toISOString(), actor: 'system' },
      { event_id: 'e3', type: 'review_completed', timestamp: new Date().toISOString(), actor: 'system' },
    ];
    writeFileSync(
      join(tempDir, 'learn', 'audit', 'events.jsonl'),
      events.map(e => JSON.stringify(e)).join('\n') + '\n',
    );

    const c = capture();
    const r = await runAudit({ argv: ['stats'], cwd: tempDir, stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('candidate_override: 2');
    expect(c.out()).toContain('review_completed: 1');
  });
});
