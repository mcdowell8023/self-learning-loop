/**
 * workspace-detector unit tests.
 * T-SLL-002a — 4 test cases.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectWorkspaces, type DetectedWorkspace } from '../workspace-detector.js';

describe('workspace-detector', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ws-detect-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('detects OpenClaw workspace', async () => {
    mkdirSync(join(fakeHome, '.openclaw/workspace'), { recursive: true });
    mkdirSync(join(fakeHome, '.openclaw/agents'), { recursive: true });

    const results = await detectWorkspaces(fakeHome);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const oc = results.find((r) => r.runtime === 'openclaw');
    expect(oc).toBeDefined();
    expect(oc!.confidence).toBe(1); // 0.6 + 0.4
    expect(oc!.agentsRoot).toContain('.openclaw/agents');
  });

  it('detects multiple runtimes coexisting', async () => {
    mkdirSync(join(fakeHome, '.openclaw/workspace'), { recursive: true });
    mkdirSync(join(fakeHome, '.claude/projects'), { recursive: true });
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });

    const results = await detectWorkspaces(fakeHome);
    const runtimes = results.map((r) => r.runtime);
    expect(runtimes).toContain('openclaw');
    expect(runtimes).toContain('claude-code');
    expect(runtimes).toContain('codex');
  });

  it('returns empty array when no runtimes found', async () => {
    const results = await detectWorkspaces(fakeHome);
    expect(results).toEqual([]);
  });

  it('sorts by priority (openclaw > claude-code > opencode > codex)', async () => {
    mkdirSync(join(fakeHome, '.openclaw/workspace'), { recursive: true });
    mkdirSync(join(fakeHome, '.claude/projects'), { recursive: true });
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });

    const results = await detectWorkspaces(fakeHome);
    const runtimes = results.map((r) => r.runtime);
    expect(runtimes.indexOf('openclaw')).toBeLessThan(runtimes.indexOf('claude-code'));
    expect(runtimes.indexOf('claude-code')).toBeLessThan(runtimes.indexOf('codex'));
  });
});
