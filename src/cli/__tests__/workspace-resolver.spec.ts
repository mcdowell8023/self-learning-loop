// src/cli/__tests__/workspace-resolver.spec.ts

import { describe, it, expect, vi } from 'vitest';
import { resolveWorkspace } from '../workspace-resolver.js';

// Mock fs.existsSync for detection tests
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // Only return true for paths we set up in tests
      if (typeof (globalThis as any).__mockExistsPaths === 'function') {
        return (globalThis as any).__mockExistsPaths(p);
      }
      return actual.existsSync(p);
    }),
  };
});

describe('resolveWorkspace', () => {
  const emptyEnv = {} as NodeJS.ProcessEnv;
  const fakeHome = '/fakehome';

  it('1. --workspace flag has highest priority', () => {
    const result = resolveWorkspace({
      workspaceFlag: '/explicit/path',
      cwd: '/some/cwd',
      env: { LEARNING_LOOP_WORKSPACE: '/env-path' } as NodeJS.ProcessEnv,
      homeOverride: fakeHome,
    });
    expect(result.workspace).toBe('/explicit/path');
    expect(result.source).toBe('flag');
  });

  it('2. relative --workspace flag resolves against cwd', () => {
    const result = resolveWorkspace({
      workspaceFlag: 'relative/ws',
      cwd: '/base',
      env: emptyEnv,
      homeOverride: fakeHome,
    });
    expect(result.workspace).toBe('/base/relative/ws');
    expect(result.source).toBe('flag');
  });

  it('3. $LEARNING_LOOP_WORKSPACE env takes precedence over OPENCLAW_WORKSPACE', () => {
    const result = resolveWorkspace({
      cwd: '/cwd',
      env: {
        LEARNING_LOOP_WORKSPACE: '/llm-ws',
        OPENCLAW_WORKSPACE: '/oc-ws',
      } as NodeJS.ProcessEnv,
      homeOverride: fakeHome,
    });
    expect(result.workspace).toBe('/llm-ws');
    expect(result.source).toBe('env-llm');
  });

  it('4. $OPENCLAW_WORKSPACE env used when LEARNING_LOOP_WORKSPACE absent', () => {
    const result = resolveWorkspace({
      cwd: '/cwd',
      env: { OPENCLAW_WORKSPACE: '/oc-ws' } as NodeJS.ProcessEnv,
      homeOverride: fakeHome,
    });
    expect(result.workspace).toBe('/oc-ws');
    expect(result.source).toBe('env-openclaw');
  });

  it('5. auto-detect finds ~/.openclaw with candidates.db', () => {
    const target = `${fakeHome}/.openclaw`;
    (globalThis as any).__mockExistsPaths = (p: string) =>
      p === `${target}/learn/candidates.db`;

    const result = resolveWorkspace({
      cwd: '/cwd',
      env: emptyEnv,
      homeOverride: fakeHome,
    });
    expect(result.workspace).toBe(target);
    expect(result.source).toBe('detected');

    delete (globalThis as any).__mockExistsPaths;
  });

  it('6. fallback to cwd when nothing matches', () => {
    (globalThis as any).__mockExistsPaths = () => false;

    const result = resolveWorkspace({
      cwd: '/my/cwd',
      env: emptyEnv,
      homeOverride: fakeHome,
    });
    expect(result.workspace).toBe('/my/cwd');
    expect(result.source).toBe('cwd-fallback');

    delete (globalThis as any).__mockExistsPaths;
  });
});
