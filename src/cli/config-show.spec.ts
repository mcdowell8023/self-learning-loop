// src/cli/config-show.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { runConfigShow } from './config-show.js';
import { __resetConfigForTests } from '../config/loader.js';

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

beforeEach(() => {
  __resetConfigForTests();
});

const emptyLoaderOpts = {
  projectConfigPath: '/tmp/nonexistent-sll006.yaml',
  userConfigPath: '/tmp/nonexistent-sll006-user.yaml',
  env: {},
};

describe('config show CLI', () => {
  it('shows help', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--help'], stdout: c.stdout, stderr: c.stderr });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('config show');
    expect(c.out()).toContain('--json');
    expect(c.out()).toContain('--key');
  });

  it('shows config as JSON with field/value/source rows', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--json'], stdout: c.stdout, stderr: c.stderr, loaderOpts: emptyLoaderOpts });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(c.out());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    const first = parsed[0];
    expect(first).toHaveProperty('field');
    expect(first).toHaveProperty('value');
    expect(first).toHaveProperty('source');
  });

  it('shows single key with source', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--key', 'reflect.temperature'], stdout: c.stdout, stderr: c.stderr, loaderOpts: emptyLoaderOpts });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('reflect.temperature');
    expect(c.out()).toContain('default');
  });

  it('errors on missing key', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--key', 'nonexistent.path'], stdout: c.stdout, stderr: c.stderr, loaderOpts: emptyLoaderOpts });
    expect(r.exitCode).toBe(3);
    expect(c.err()).toContain('key not found');
  });

  it('table format shows header row', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--format', 'table'], stdout: c.stdout, stderr: c.stderr, loaderOpts: emptyLoaderOpts });
    expect(r.exitCode).toBe(0);
    expect(c.out()).toContain('Field');
    expect(c.out()).toContain('Value');
    expect(c.out()).toContain('Source');
  });

  it('--format json produces same result as --json', async () => {
    const c1 = capture();
    await runConfigShow({ argv: ['--json'], stdout: c1.stdout, stderr: c1.stderr, loaderOpts: emptyLoaderOpts });
    __resetConfigForTests();
    const c2 = capture();
    await runConfigShow({ argv: ['--format', 'json'], stdout: c2.stdout, stderr: c2.stderr, loaderOpts: emptyLoaderOpts });
    expect(c1.out()).toBe(c2.out());
  });

  it('all default fields show source=default', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--json'], stdout: c.stdout, stderr: c.stderr, loaderOpts: emptyLoaderOpts });
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(c.out());
    for (const row of rows) {
      expect(row.source).toBe('default');
    }
  });

  it('single key JSON includes source field', async () => {
    const c = capture();
    const r = await runConfigShow({ argv: ['--key', 'runtime', '--json'], stdout: c.stdout, stderr: c.stderr, loaderOpts: emptyLoaderOpts });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(c.out());
    expect(parsed.key).toBe('runtime');
    expect(parsed.value).toBe('auto');
    expect(parsed.source).toBe('default');
  });
});
