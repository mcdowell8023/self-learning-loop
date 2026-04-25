// src/store/watermark.spec.ts
// Tests for reflection_watermark and reflection_log tables

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCandidateStore, type CandidateStore } from './candidate-store.js';

let tmpRoot: string;
let store: CandidateStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'watermark-'));
  store = openCandidateStore({ dbPath: join(tmpRoot, 'test.db') });
});

afterEach(() => {
  store.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('reflection_watermark', () => {
  it('returns null when no watermark set', () => {
    expect(store.getWatermark()).toBeNull();
  });

  it('sets and gets watermark', () => {
    store.setWatermark('2026-04-22');
    expect(store.getWatermark()).toBe('2026-04-22');
  });

  it('updates watermark (upsert)', () => {
    store.setWatermark('2026-04-22');
    store.setWatermark('2026-04-23');
    expect(store.getWatermark()).toBe('2026-04-23');
  });

  it('supports custom keys', () => {
    store.setWatermark('2026-04-22', 'custom');
    expect(store.getWatermark('custom')).toBe('2026-04-22');
    expect(store.getWatermark()).toBeNull(); // default key unset
  });
});

describe('reflection_log', () => {
  it('returns false for non-existent log', () => {
    expect(store.hasReflectionLog('2026-04-22', 'abc123')).toBe(false);
  });

  it('adds and checks log entry', () => {
    store.addReflectionLog('2026-04-22', 'abc123', 3);
    expect(store.hasReflectionLog('2026-04-22', 'abc123')).toBe(true);
  });

  it('dedup: same date+hash ignored', () => {
    store.addReflectionLog('2026-04-22', 'abc123', 3);
    store.addReflectionLog('2026-04-22', 'abc123', 5); // should be ignored
    expect(store.hasReflectionLog('2026-04-22', 'abc123')).toBe(true);
  });

  it('different hash for same date is separate entry', () => {
    store.addReflectionLog('2026-04-22', 'abc123', 3);
    expect(store.hasReflectionLog('2026-04-22', 'def456')).toBe(false);
    store.addReflectionLog('2026-04-22', 'def456', 2);
    expect(store.hasReflectionLog('2026-04-22', 'def456')).toBe(true);
  });
});
