// src/store/__tests__/candidate-mirror.spec.ts
// T-SLL-003 — 候选文件镜像 + repair 测试

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

import { CandidateStore } from '../candidate-store.js';
import {
  writeMirror,
  renderMirror,
  mirrorPath,
  isMirrorCurrent,
  repairMirrors,
} from '../candidate-mirror.js';
import type { Strategy, Instance, Candidate } from '../../kernel/types.js';

function makeStrategy(id: string, scope = 'session' as const): Strategy {
  return {
    strategy_id: id,
    problem_category: 'test-category',
    trigger_conditions: 'when tests fail',
    recommended_action: 'fix the tests',
    scope,
    tags: ['test'],
    created_at: '2026-04-25T10:00:00.000Z',
    instance_ids: [`${id}-inst-1`],
  };
}

function makeInstance(strategyId: string): Instance {
  return {
    instance_id: `${strategyId}-inst-1`,
    strategy_id: strategyId,
    diff_summary: 'fixed a bug',
    files_touched: ['src/foo.ts'],
    env_fingerprint: { runtime: 'openclaw', workspace: '/tmp/test', os: 'linux', node_version: '22' },
    source_sessions: [{ session_id: 'sess-1', runtime: 'openclaw', timestamp: '2026-04-25T10:00:00Z' }],
    assertions: [{ type: 'file_exists', description: 'src/foo.ts exists' }],
    trial_results: [],
    created_at: '2026-04-25T10:00:00.000Z',
  };
}

describe('candidate-mirror', () => {
  let tmpDir: string;
  let candidatesDir: string;
  let store: CandidateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mirror-test-'));
    candidatesDir = join(tmpDir, 'candidates');
    store = new CandidateStore({
      dbPath: ':memory:',
      candidatesDir,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('写入候选 → 镜像文件存在 + frontmatter 正确', () => {
    const candidate = store.create({
      strategy: makeStrategy('abc12345-test-1'),
      instances: [makeInstance('abc12345-test-1')],
    });

    const mp = mirrorPath(candidatesDir, candidate);
    expect(existsSync(mp)).toBe(true);

    const content = readFileSync(mp, 'utf-8');
    expect(content).toContain('---');

    // Parse frontmatter
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).toBeTruthy();
    const fm = YAML.parse(fmMatch![1]);
    expect(fm.id).toBe('abc12345-test-1');
    expect(fm.problem_category).toBe('test-category');
    expect(fm.state).toBe('pending');
    expect(fm.scope).toBe('session');
    expect(fm.source_runtime).toBe('openclaw');
  });

  it('状态变更 → 镜像同步更新（updated_at 变化）', async () => {
    const candidate = store.create({
      strategy: makeStrategy('abc12345-test-2'),
      instances: [makeInstance('abc12345-test-2')],
    });

    const mp = mirrorPath(candidatesDir, candidate);
    const contentBefore = readFileSync(mp, 'utf-8');

    // Wait a tick to ensure different timestamp
    await new Promise(r => setTimeout(r, 10));

    store.transition('abc12345-test-2', 'pending', 'reviewing', 'start_review');

    const contentAfter = readFileSync(mp, 'utf-8');
    expect(contentAfter).not.toBe(contentBefore);

    const fmMatch = contentAfter.match(/^---\n([\s\S]*?)\n---/);
    const fm = YAML.parse(fmMatch![1]);
    expect(fm.state).toBe('reviewing');
  });

  it('原子写入：.tmp 文件不残留', () => {
    const candidate = store.create({
      strategy: makeStrategy('abc12345-test-3'),
      instances: [makeInstance('abc12345-test-3')],
    });

    const mp = mirrorPath(candidatesDir, candidate);
    const tmpPath = mp + '.tmp';
    // After successful write, .tmp should not exist
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(mp)).toBe(true);
  });

  it('repair：删一个镜像文件 → repair 后恢复', () => {
    const candidate = store.create({
      strategy: makeStrategy('abc12345-test-4'),
      instances: [makeInstance('abc12345-test-4')],
    });

    const mp = mirrorPath(candidatesDir, candidate);
    expect(existsSync(mp)).toBe(true);

    // Delete the mirror
    unlinkSync(mp);
    expect(existsSync(mp)).toBe(false);

    // Repair
    const candidates = store.list();
    const result = repairMirrors(candidatesDir, candidates);
    expect(result.written).toBe(1);
    expect(existsSync(mp)).toBe(true);
  });

  it('repair --dry-run：只打印不写', () => {
    const candidate = store.create({
      strategy: makeStrategy('abc12345-test-5'),
      instances: [makeInstance('abc12345-test-5')],
    });

    const mp = mirrorPath(candidatesDir, candidate);
    unlinkSync(mp);

    const candidates = store.list();
    const result = repairMirrors(candidatesDir, candidates, { dryRun: true });
    expect(result.written).toBe(1);
    // File should NOT be written in dry-run
    expect(existsSync(mp)).toBe(false);
  });

  it('isMirrorCurrent 检测过期镜像', () => {
    const candidate = store.create({
      strategy: makeStrategy('abc12345-test-6'),
      instances: [makeInstance('abc12345-test-6')],
    });

    expect(isMirrorCurrent(candidatesDir, candidate)).toBe(true);

    // Transition changes state → mirror becomes stale
    const updated = store.transition('abc12345-test-6', 'pending', 'reviewing', 'start_review');

    // Mirror was auto-updated by store, so should still be current
    expect(isMirrorCurrent(candidatesDir, updated)).toBe(true);
  });
});
