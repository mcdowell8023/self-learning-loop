/**
 * Tests for GenericAdapter + YAML mapping schema.
 * Ref: T-SLL-012
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GenericMappingSchema } from '../generic-schema.js';
import { GenericAdapter } from '../generic.js';

// ─── Fixtures ───────────────────────────────────────

const TMP = join(tmpdir(), `generic-adapter-test-${Date.now()}`);
const SESSIONS_DIR = join(TMP, 'sessions');
const VALID_YAML_PATH = join(TMP, 'test-mapping.yaml');
const INVALID_YAML_PATH = join(TMP, 'bad-mapping.yaml');
const CODEX_YAML = join(__dirname, '../../../configs/codex-mapping.yaml');

const SAMPLE_JSONL = [
  JSON.stringify({ role: 'user', content: 'Hello', timestamp: '2026-04-25T10:00:00Z' }),
  JSON.stringify({ role: 'assistant', content: 'Hi there', timestamp: '2026-04-25T10:00:01Z' }),
  JSON.stringify({ role: 'user', content: 'Bye', timestamp: '2026-04-25T10:00:02Z' }),
].join('\n') + '\n';

beforeAll(() => {
  mkdirSync(SESSIONS_DIR, { recursive: true });

  // Write sample session file
  writeFileSync(join(SESSIONS_DIR, 'session-001.jsonl'), SAMPLE_JSONL);

  // Write valid mapping YAML
  writeFileSync(VALID_YAML_PATH, `
runtime_id: test-runtime
workspace_paths:
  - ${SESSIONS_DIR}
session_format: jsonl
session_glob: "**/*.jsonl"
field_mapping:
  role: $.role
  content: $.content
  timestamp: $.timestamp
`);

  // Write invalid mapping YAML (missing required fields)
  writeFileSync(INVALID_YAML_PATH, `
session_format: jsonl
`);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ─── Schema tests ───────────────────────────────────

describe('GenericMappingSchema', () => {
  it('should validate a complete mapping', () => {
    const result = GenericMappingSchema.safeParse({
      runtime_id: 'test',
      workspace_paths: ['/tmp/test'],
      session_format: 'jsonl',
      session_glob: '**/*.jsonl',
      field_mapping: { role: '$.role', content: '$.content' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing required fields', () => {
    const result = GenericMappingSchema.safeParse({
      session_format: 'jsonl',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map(i => i.path.join('.'));
      expect(paths).toContain('runtime_id');
      expect(paths).toContain('workspace_paths');
    }
  });
});

// ─── Adapter tests ──────────────────────────────────

describe('GenericAdapter', () => {
  it('should load a valid YAML mapping', () => {
    const adapter = new GenericAdapter(VALID_YAML_PATH);
    expect(adapter.id).toBe('test-runtime');
    expect(adapter.displayName).toContain('test-runtime');
  });

  it('should throw on invalid YAML mapping', () => {
    expect(() => new GenericAdapter(INVALID_YAML_PATH)).toThrow(/Invalid YAML mapping/);
  });

  it('detect() returns true when workspace path exists', async () => {
    const adapter = new GenericAdapter(VALID_YAML_PATH);
    expect(await adapter.detect()).toBe(true);
  });

  it('detect() returns false when no paths exist', async () => {
    const noExistYaml = join(TMP, 'noexist.yaml');
    writeFileSync(noExistYaml, `
runtime_id: ghost
workspace_paths:
  - /nonexistent/path/that/does/not/exist
session_format: jsonl
`);
    const adapter = new GenericAdapter(noExistYaml);
    expect(await adapter.detect()).toBe(false);
  });

  it('listNewSessions scans and returns session refs', async () => {
    const adapter = new GenericAdapter(VALID_YAML_PATH);
    const refs = await adapter.listNewSessions(new Date('2000-01-01'));
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs[0].runtime).toBe('test-runtime');
    expect(refs[0].sessionId).toBe('session-001');
  });

  it('extractEvents yields normalized events from jsonl', async () => {
    const adapter = new GenericAdapter(VALID_YAML_PATH);
    const refs = await adapter.listNewSessions(new Date('2000-01-01'));
    const events: Array<{ type: string; content: string }> = [];
    for await (const ev of adapter.extractEvents(refs[0])) {
      events.push(ev as any);
    }
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('user_message');
    expect(events[0].content).toBe('Hello');
    expect(events[1].type).toBe('assistant_message');
    expect(events[1].content).toBe('Hi there');
  });
});

// ─── Codex mapping integration ──────────────────────

describe('codex-mapping.yaml', () => {
  it('should load and validate the codex mapping file', () => {
    expect(existsSync(CODEX_YAML)).toBe(true);
    // GenericAdapter constructor validates the YAML — if it doesn't throw, schema is valid.
    // But detect() will be false since ~/.codex doesn't exist in CI.
    const adapter = new GenericAdapter(CODEX_YAML);
    expect(adapter.id).toBe('codex');
  });
});
