// src/cli/__tests__/reflect-events.spec.ts
//
// Tests for A3 (event writing) + A4 (reporter hook) functionality

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findReporterSkill, writeReflectionEvent } from '../reflect.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('findReporterSkill', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `reflect-events-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns null when reporter skill is not installed', () => {
    expect(findReporterSkill(tmpHome)).toBeNull();
  });

  it('returns bin path when SKILL.md + CLI both exist', () => {
    const skillDir = join(tmpHome, '.openclaw', 'workspace', 'skills', 'learning-loop-reporter');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Reporter');

    const binDir = join(tmpHome, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, 'learning-loop-reporter');
    writeFileSync(binPath, '#!/bin/bash\necho ok');

    expect(findReporterSkill(tmpHome)).toBe(binPath);
  });

  it('returns bin path when only CLI exists (no SKILL.md)', () => {
    const binDir = join(tmpHome, '.local', 'bin');
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, 'learning-loop-reporter');
    writeFileSync(binPath, '#!/bin/bash\necho ok');

    expect(findReporterSkill(tmpHome)).toBe(binPath);
  });

  it('returns null when SKILL.md exists but no CLI binary', () => {
    const skillDir = join(tmpHome, '.openclaw', 'workspace', 'skills', 'learning-loop-reporter');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# Reporter');

    expect(findReporterSkill(tmpHome)).toBeNull();
  });
});

describe('writeReflectionEvent', () => {
  let tmpWs: string;

  beforeEach(() => {
    tmpWs = join(tmpdir(), `reflect-event-write-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpWs, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpWs, { recursive: true, force: true });
  });

  it('writes reflection-completed.json with correct content', () => {
    const eventData = { event: 'reflection-completed', timestamp: '2026-04-27T07:00:00Z', summary: 'test' };
    writeReflectionEvent(tmpWs, eventData);

    const finalPath = join(tmpWs, 'learn', 'events', 'reflection-completed.json');
    expect(existsSync(finalPath)).toBe(true);

    const written = JSON.parse(readFileSync(finalPath, 'utf-8'));
    expect(written.event).toBe('reflection-completed');
    expect(written.summary).toBe('test');
  });

  it('creates events directory if it does not exist', () => {
    writeReflectionEvent(tmpWs, { event: 'test' });
    const eventsDir = join(tmpWs, 'learn', 'events');
    expect(existsSync(eventsDir)).toBe(true);
  });

  it('atomic write — no .tmp file left behind', () => {
    writeReflectionEvent(tmpWs, { event: 'test' });
    const tmpPath = join(tmpWs, 'learn', 'events', '.reflection-completed.json.tmp');
    expect(existsSync(tmpPath)).toBe(false);
  });
});
