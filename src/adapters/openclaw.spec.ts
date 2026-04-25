/**
 * OpenClawAdapter — unit tests.
 * Covers P1a test cases #52, #53, #96, #97, #98, #112.
 */
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { SessionEventSchema, type SessionEvent } from '../kernel/schemas/session.js';
import type { AuditEvent } from '../kernel/schemas/audit.js';
import {
  OpenClawAdapter,
  computeContentHash,
  deduplicateEvents,
  envRichnessScore,
  preferRicherEnv,
} from './openclaw.js';

// ─── Helpers ────────────────────────────────────────

const here = fileURLToPath(new URL('.', import.meta.url));
// src/adapters/ → project root → fixtures/sample-session.jsonl
const FIXTURE_PATH = join(here, '..', '..', 'fixtures', 'sample-session.jsonl');

let tmpRoot: string;
let sessionsDir: string;
let workspaceDir: string;
let stateFilePath: string;

function makeTmpSession(name: string, content: string): string {
  const p = join(sessionsDir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

async function collectEvents(adapter: OpenClawAdapter, refPath: string, lastOffset = 0) {
  const st = statSync(refPath);
  const sessionId = refPath.split('/').pop()!.replace(/\.jsonl$/, '');
  const events: SessionEvent[] = [];
  for await (const e of adapter.extractEvents({
    path: refPath,
    runtime: 'openclaw',
    sessionId,
    startedAt: st.birthtime && st.birthtime.getTime() > 0 ? st.birthtime : st.mtime,
    byteSize: st.size,
    lastOffset,
  })) {
    events.push(e);
  }
  return { events, sessionId, size: st.size };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'learning-loop-t002-'));
  sessionsDir = join(tmpRoot, 'sessions');
  workspaceDir = join(tmpRoot, 'workspace');
  stateFilePath = join(workspaceDir, 'learn', 'config', 'collect-state.json');
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────

describe('[P1a] OpenClawAdapter — real fixture parse', () => {
  // Test case #52: oc_adapter_session_parse
  it('#52 parses a real OpenClaw session → ≥1 SessionEvent, schema-valid, JSON round-trip', async () => {
    const adapter = new OpenClawAdapter({
      sessionsDir,
      recursive: false,
      stateFilePath,
    });
    const content = readFileSync(FIXTURE_PATH, 'utf-8');
    const filePath = makeTmpSession('sample.jsonl', content);

    const { events } = await collectEvents(adapter, filePath);

    expect(events.length).toBeGreaterThanOrEqual(1);

    // Every event must pass the schema.
    for (const e of events) {
      expect(() => SessionEventSchema.parse(e)).not.toThrow();
      // contentHash is 32 hex chars (128 bit).
      expect(e.contentHash).toMatch(/^[0-9a-f]{32}$/);
    }

    // JSON round-trip preserves type and hash.
    const serialized = JSON.stringify(events);
    const revived = JSON.parse(serialized) as unknown[];
    for (const r of revived) {
      expect(() => SessionEventSchema.parse(r)).not.toThrow();
    }

    // Must have captured at least one user_message from the fixture.
    expect(events.some(e => e.type === 'user_message')).toBe(true);
  });

  // Test case #53: oc_adapter_tool_call_extract
  it('#53 extracts tool_call and tool_result events from message content parts', async () => {
    const adapter = new OpenClawAdapter({
      sessionsDir,
      recursive: false,
      stateFilePath,
    });
    const content = readFileSync(FIXTURE_PATH, 'utf-8');
    const filePath = makeTmpSession('sample.jsonl', content);

    const { events } = await collectEvents(adapter, filePath);

    const toolCalls = events.filter(e => e.type === 'tool_call');
    const toolResults = events.filter(e => e.type === 'tool_result');

    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolResults.length).toBeGreaterThanOrEqual(1);

    // Metadata carries tool_name and tool_call_id linkage.
    const call = toolCalls[0]!;
    expect(call.metadata['tool_name']).toBe('exec');
    expect(call.metadata['tool_call_id']).toBe('toolu_01');

    const result = toolResults[0]!;
    expect(result.metadata['tool_call_id']).toBe('toolu_01');
    expect(result.content).toContain('file1.txt');
  });
});

describe('[P1a] OpenClawAdapter — robustness', () => {
  // Test case #96: adapter_skip_malformed_line_with_audit
  it('#96 skips malformed JSON lines, records audit event, does not crash', async () => {
    const audit: AuditEvent[] = [];
    const adapter = new OpenClawAdapter({
      sessionsDir,
      recursive: false,
      stateFilePath,
      auditSink: e => audit.push(e),
    });

    const body = [
      '{"type":"message","id":"a","timestamp":"2026-03-29T14:00:14Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
      '{ this is not json',
      '',
      '{"type":"message","id":"b","timestamp":"2026-03-29T14:00:15Z","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}',
      '',
    ].join('\n');

    const filePath = makeTmpSession('malformed.jsonl', body);
    const { events } = await collectEvents(adapter, filePath);

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('user_message');
    expect(events[1]!.type).toBe('assistant_message');

    const malformed = audit.find(a => a.type === 'adapter.malformed_line_skipped');
    expect(malformed).toBeDefined();
    expect(malformed!.data['session_id']).toBe('malformed');
    expect(malformed!.data['line_no']).toBe(2);
    expect(malformed!.actor).toBe('openclaw');
  });
});

describe('[P1a] OpenClawAdapter — incremental offsets', () => {
  // Test case #97: adapter_resume_from_last_offset
  it('#97 persists offset and resumes from where previous pass stopped', async () => {
    const line1 =
      '{"type":"message","id":"a","timestamp":"2026-03-29T14:00:14Z","message":{"role":"user","content":[{"type":"text","text":"first"}]}}';
    const line2 =
      '{"type":"message","id":"b","timestamp":"2026-03-29T14:00:15Z","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}';

    const filePath = makeTmpSession('incr.jsonl', line1 + '\n');

    // First pass: consume what's there, flush offset to disk.
    const a1 = new OpenClawAdapter({ sessionsDir, recursive: false, stateFilePath });
    const first = await collectEvents(a1, filePath);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]!.content).toBe('first');
    a1.flushOffsets();

    const state = JSON.parse(readFileSync(stateFilePath, 'utf-8'));
    expect(state.offsets['incr']).toBe(Buffer.byteLength(line1, 'utf-8') + 1);

    // Append a second line and create a fresh adapter — it should pick up offset.
    writeFileSync(filePath, line1 + '\n' + line2 + '\n', 'utf-8');
    const a2 = new OpenClawAdapter({ sessionsDir, recursive: false, stateFilePath });
    expect(a2.getOffset('incr')).toBe(Buffer.byteLength(line1, 'utf-8') + 1);

    const second = await collectEvents(a2, filePath, a2.getOffset('incr'));
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.content).toBe('second');
  });
});

describe('[P1a] OpenClawAdapter — content hashing', () => {
  // Test case #98: adapter_content_hash_stable_across_runtime
  it('#98 contentHash is 32 chars and stable across adapters for same (type, content)', () => {
    const a = computeContentHash({ type: 'user_message', content: 'hello world' });
    const b = computeContentHash({ type: 'user_message', content: 'hello world' });
    const c = computeContentHash({ type: 'assistant_message', content: 'hello world' });
    const d = computeContentHash({ type: 'user_message', content: 'HELLO world' });

    expect(a).toHaveLength(32);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c); // type changes hash
    expect(a).not.toBe(d); // content changes hash
  });
});

describe('[P1a] Dedup — prefer_richer_env', () => {
  // Test case #112: dedup_prefers_richer_env_on_same_content_hash
  it('#112 on same contentHash within 30s window, keeps the event with richer env_fingerprint', () => {
    const ts = new Date('2026-04-01T00:00:00Z');
    const within = new Date(ts.getTime() + 5_000); // 5s later
    const base = {
      type: 'user_message' as const,
      timestamp: ts,
      content: 'run tests',
      metadata: {},
      contentHash: computeContentHash({ type: 'user_message', content: 'run tests' }),
    };
    const poor = {
      ...base,
      env_fingerprint: { runtime: 'openclaw', platform: 'linux' as const, arch: 'x64' as const },
    };
    const rich = {
      ...base,
      timestamp: within,
      env_fingerprint: {
        runtime: 'openclaw',
        platform: 'linux' as const,
        arch: 'x64' as const,
        model: 'claude-opus-4.7',
        nodeVersion: 'v22.14.0',
        runtimeVersion: '2026.4.15',
        extensions: { feature_a: true, feature_b: 'x' },
      },
    };

    // Richness ordering sanity.
    expect(envRichnessScore(rich.env_fingerprint)).toBeGreaterThan(
      envRichnessScore(poor.env_fingerprint),
    );
    expect(preferRicherEnv(poor, rich)).toBe(rich);
    expect(preferRicherEnv(rich, poor)).toBe(rich);

    // Full deduplicateEvents run — rich one wins, only 1 result.
    const out = deduplicateEvents([poor, rich]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(rich);

    // Outside the 30s window both are kept.
    const far = {
      ...rich,
      timestamp: new Date(ts.getTime() + 60_000),
    };
    const out2 = deduplicateEvents([poor, far]);
    expect(out2).toHaveLength(2);
  });
});

describe('[P1a] OpenClawAdapter — env fingerprint', () => {
  it('reports runtime=openclaw with current platform/arch', async () => {
    const adapter = new OpenClawAdapter({ sessionsDir, recursive: false, stateFilePath });
    const env = await adapter.getEnvFingerprint();
    expect(env.runtime).toBe('openclaw');
    expect(env.platform).toBe(process.platform);
    expect(env.arch).toBe(process.arch);
    expect(env.nodeVersion).toBe(process.version);
  });

  it('detect() returns false when sessionsDir is empty', async () => {
    const adapter = new OpenClawAdapter({ sessionsDir, recursive: false, stateFilePath });
    expect(await adapter.detect()).toBe(false);
  });

  it('detect() returns true once a jsonl file exists', async () => {
    makeTmpSession('x.jsonl', '{"type":"session","id":"x","timestamp":"2026-01-01T00:00:00Z"}\n');
    const adapter = new OpenClawAdapter({ sessionsDir, recursive: false, stateFilePath });
    expect(await adapter.detect()).toBe(true);
  });

  it('flushOffsets creates state file atomically', async () => {
    const adapter = new OpenClawAdapter({ sessionsDir, recursive: false, stateFilePath });
    makeTmpSession(
      'f.jsonl',
      '{"type":"message","id":"a","timestamp":"2026-03-29T14:00:14Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n',
    );
    await collectEvents(adapter, join(sessionsDir, 'f.jsonl'));
    adapter.flushOffsets();
    expect(existsSync(stateFilePath)).toBe(true);
    const state = JSON.parse(readFileSync(stateFilePath, 'utf-8'));
    expect(state.offsets).toBeDefined();
    expect(typeof state.offsets['f']).toBe('number');
  });
});
