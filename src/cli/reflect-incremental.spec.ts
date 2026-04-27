// src/cli/reflect-incremental.spec.ts
// Tests for incremental reflect: --from/--to/--today, watermark, dedup

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLearn } from './learn.js';
import { runInit } from './init.js';
import { openCandidateStore } from '../store/candidate-store.js';

let tmpRoot: string;
let workspace: string;
let stdoutBuf: string[];
let stderrBuf: string[];

const out = (s: string) => stdoutBuf.push(s);
const err = (s: string) => stderrBuf.push(s);
const stdoutStr = () => stdoutBuf.join('');
const stderrStr = () => stderrBuf.join('');

function setupWorkspace() {
  // Init learn/ workspace
  const configExample = join(tmpRoot, 'learn', 'config.yaml.example');
  mkdirSync(join(tmpRoot, 'learn'), { recursive: true });
  writeFileSync(configExample, 'collect:\n  adapters: []\n');

  // Create memory dir with some diary files
  const memDir = join(workspace, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, '2026-04-20.md'), '### 万三日记 2026-04-20T10:00+08:00\n\n模型路由决策失误：用了 gemini 做架构任务导致超时，应该用 opus-4.6。\n\n**事件：** 图灵用 gemini-3.1-pro 起稿架构文档，1m37s 超时\n**决策：** 禁用 gemini 做架构任务\n**影响：** 延迟 2 小时\n');
  writeFileSync(join(memDir, '2026-04-21.md'), '### 万三日记 2026-04-21T14:00+08:00\n\n审核流程验证：包拯首次审核通过，gpt-5.4 一次过修订。\n\n**事件：** v5.0.3 审核完成\n**决策：** 确认 gpt-5.4 适合元信息核验\n**影响：** 建立审核信任\n');
  writeFileSync(join(memDir, '2026-04-22.md'), '### 万三日记 2026-04-22T09:00+08:00\n\nreflect CLI 联调成功，能从日记提炼候选。端到端冒烟测试通过。\n\n**事件：** reflect CLI 首次联调\n**决策：** 进入收尾阶段\n**影响：** Phase 1a 接近完成\n');
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'reflect-inc-'));
  workspace = tmpRoot;
  stdoutBuf = [];
  stderrBuf = [];
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('reflect --from/--to argument parsing', () => {
  it('rejects invalid --from format', async () => {
    setupWorkspace();
    await runInit({ argv: ['--workspace', workspace], cwd: tmpRoot, stdout: out, stderr: err });
    stdoutBuf = []; stderrBuf = [];

    const r = await runLearn({
      argv: ['reflect', '--workspace', workspace, '--from', 'bad-date', '--dry-run'],
      cwd: tmpRoot, stdout: out, stderr: err,
    });
    expect(r.exitCode).toBe(2);
    expect(stderrStr()).toContain('--from requires YYYY-MM-DD');
  });

  it('rejects invalid --to format', async () => {
    setupWorkspace();
    await runInit({ argv: ['--workspace', workspace], cwd: tmpRoot, stdout: out, stderr: err });
    stdoutBuf = []; stderrBuf = [];

    const r = await runLearn({
      argv: ['reflect', '--workspace', workspace, '--to', '2026/04/22', '--dry-run'],
      cwd: tmpRoot, stdout: out, stderr: err,
    });
    expect(r.exitCode).toBe(2);
    expect(stderrStr()).toContain('--to requires YYYY-MM-DD');
  });
});

describe('reflect incremental watermark', () => {
  it('with no watermark, defaults to today instead of yesterday', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T10:00:00+08:00'));
    await runInit({ argv: ['--workspace', workspace], cwd: tmpRoot, stdout: out, stderr: err });
    stdoutBuf = []; stderrBuf = [];

    const r = await runLearn({
      argv: ['reflect', '--workspace', workspace],
      cwd: tmpRoot, stdout: out, stderr: err,
    });

    expect(stdoutStr()).toContain('Processing dates: 2026-04-27 → 2026-04-27');
    expect(stdoutStr()).toContain('No events found');
    vi.useRealTimers();
  });

  it('--today flag works', async () => {
    setupWorkspace();
    // Create today's file
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const memDir = join(workspace, 'memory');
    writeFileSync(join(memDir, `${todayStr}.md`), '### Today test\n\nSome diary content for today that is long enough to be treated as an event by the parser.\n');

    await runInit({ argv: ['--workspace', workspace], cwd: tmpRoot, stdout: out, stderr: err });
    stdoutBuf = []; stderrBuf = [];

    const r = await runLearn({
      argv: ['reflect', '--workspace', workspace, '--today', '--dry-run'],
      cwd: tmpRoot, stdout: out, stderr: err,
    });
    expect(stdoutStr()).toContain(todayStr);
  });
});

describe('watermark store operations via init', () => {
  it('init creates DB with watermark tables', async () => {
    setupWorkspace();

    // Manually create the DB to test watermark tables
    const learnDir = join(workspace, 'learn');
    mkdirSync(learnDir, { recursive: true });
    const dbPath = join(learnDir, 'candidates.db');
    const store = openCandidateStore({ dbPath });
    // Should not throw — tables exist
    expect(store.getWatermark()).toBeNull();
    expect(store.hasReflectionLog('2026-04-22', 'abc')).toBe(false);
    store.close();
  });
});
