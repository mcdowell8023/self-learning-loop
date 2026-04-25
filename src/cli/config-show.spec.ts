// src/cli/config-show.spec.ts
import { describe, it, expect } from 'vitest';
import { runConfigShow } from './config-show.js';

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

describe('config show CLI', () => {
  it('shows help', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--help'], stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('config show');
    expect(c.out()).toContain('--json');
    expect(c.out()).toContain('--key');
  });

  it('shows config as JSON', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--json'], stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(c.out());
    expect(parsed).toHaveProperty('collect');
    expect(parsed).toHaveProperty('reflect');
    expect(parsed).toHaveProperty('shadow');
  });

  it('shows single key', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--key', 'reflect.temperature'], stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('reflect.temperature');
  });

  it('errors on missing key', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--key', 'nonexistent.path'], stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(3);
    expect(c.err()).toContain('key not found');
  });
});
