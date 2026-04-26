/**
 * Tests for GenericAdapter + YAML mapping schema + Codex integration.
 * Ref: T-SLL-012
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GenericMappingSchema } from '../generic-schema.js';
import { GenericAdapter } from '../generic.js';
import type { SessionEvent } from '../../kernel/schemas/session.js';

// ─── Fixtures ───────────────────────────────────────

const TMP = join(tmpdir(), `generic-adapter-test-${Date.now()}`);
const SESSIONS_DIR = join(TMP, 'sessions');
const VALID_YAML_PATH = join(TMP, 'test-mapping.yaml');
const INVALID_YAML_PATH = join(TMP, 'bad-mapping.yaml');
const TRANSFORM_YAML_PATH = join(TMP, 'transform-mapping.yaml');
const EPOCH_YAML_PATH = join(TMP, 'epoch-mapping.yaml');
const PROJECT_ROOT = join(__dirname, '../../..');
const CODEX_YAML = join(PROJECT_ROOT, 'configs/adapters/codex.yaml');
const CODEX_FIXTURE = join(PROJECT_ROOT, 'fixtures/codex/session-001.jsonl');

const SAMPLE_JSONL = [
  JSON.stringify({ role: 'user', content: 'Hello', timestamp: '2026-04-25T10:00:00Z' }),
  JSON.stringify({ role: 'assistant', content: 'Hi there', timestamp: '2026-04-25T10:00:01Z' }),
  JSON.stringify({ role: 'user', content: 'Bye', timestamp: '2026-04-25T10:00:02Z' }),
].join('\n') + '\n';

const TRANSFORM_JSONL = [
  JSON.stringify({ who: 'human', text: 'Hello', ts: '2026-04-25T10:00:00Z' }),
  JSON.stringify({ who: 'bot', text: 'Hi there', ts: '2026-04-25T10:00:01Z' }),
  JSON.stringify({ who: 'unknown_role', text: 'System msg', ts: '2026-04-25T10:00:02Z' }),
].join('\n') + '\n';

const EPOCH_JSONL = [
  JSON.stringify({ role: 'user', content: 'Test', ts: 1745582400000 }),
].join('\n') + '\n';

beforeAll(() => {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, 'session-001.jsonl'), SAMPLE_JSONL);

  // Transform test sessions
  const transformDir = join(TMP, 'transform-sessions');
  mkdirSync(transformDir, { recursive: true });
  writeFileSync(join(transformDir, 'sess.jsonl'), TRANSFORM_JSONL);

  const epochDir = join(TMP, 'epoch-sessions');
  mkdirSync(epochDir, { recursive: true });
  writeFileSync(join(epochDir, 'sess.jsonl'), EPOCH_JSONL);

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

  writeFileSync(INVALID_YAML_PATH, `
session_format: jsonl
`);

  writeFileSync(TRANSFORM_YAML_PATH, `
runtime_id: transform-test
workspace_paths:
  - ${transformDir}
session_format: jsonl
field_mapping:
  role: $.who
  content: $.text
  timestamp: $.ts
transforms:
  role_map:
    human: user
    bot: assistant
`);

  writeFileSync(EPOCH_YAML_PATH, `
runtime_id: epoch-test
workspace_paths:
  - ${epochDir}
session_format: jsonl
field_mapping:
  role: $.role
  content: $.content
  timestamp: $.ts
transforms:
  timestamp_format: epoch_ms
`);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ─── Schema tests ───────────────────────────────────

describe('GenericMappingSchema', () => {
  it('validates a complete mapping with transforms', () => {
    const result = GenericMappingSchema.safeParse({
      runtime_id: 'test',
      workspace_paths: ['/tmp/test'],
      session_format: 'jsonl',
      field_mapping: { role: '$.role', content: '$.content' },
      transforms: { role_map: { human: 'user' }, timestamp_format: 'iso8601' },
    });
    expect(result.success).toBe(true);
  });

  it('validates without transforms (optional)', () => {
    const result = GenericMappingSchema.safeParse({
      runtime_id: 'test',
      workspace_paths: ['/tmp/test'],
      session_format: 'jsonl',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = GenericMappingSchema.safeParse({ session_format: 'jsonl' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map(i => i.path.join('.'));
      expect(paths).toContain('runtime_id');
      expect(paths).toContain('workspace_paths');
    }
  });
});

// ─── Adapter basic tests ────────────────────────────

describe('GenericAdapter', () => {
  it('loads a valid YAML mapping', () => {
    const adapter = new GenericAdapter(VALID_YAML_PATH);
    expect(adapter.id).toBe('test-runtime');
  });

  it('throws on invalid YAML mapping', () => {
    expect(() => new GenericAdapter(INVALID_YAML_PATH)).toThrow(/Invalid YAML mapping/);
  });

  it('detect() returns true when workspace exists', async () => {
    const adapter = new GenericAdapter(VALID_YAML_PATH);
    expect(await adapter.detect()).toBe(true);
  });

  it('detect() returns false when no paths exist', async () => {
    const noExist = join(TMP, 'noexist.yaml');
    writeFileSync(noExist, `runtime_id: ghost\nworkspace_paths:\n  - /nonexistent\nsession_format: jsonl\n`);
    const adapter = new GenericAdapter(noExist);
    expect(await adapter.detect()).toBe(false);
  });

  it('listNewSessions scans and returns refs', async () => {
    const adapter = new GenericAdapter(VALID_YAML_PATH);
    const refs = await adapter.listNewSessions(new Date('2000-01-01'));
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs[0].runtime).toBe('test-runtime');
  });

  it('extractEvents yields normalized events', async () => {
    const adapter = new GenericAdapter(VALID_YAML_PATH);
    const refs = await adapter.listNewSessions(new Date('2000-01-01'));
    const events: SessionEvent[] = [];
    for await (const ev of adapter.extractEvents(refs[0])) events.push(ev);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('user_message');
    expect(events[0].content).toBe('Hello');
    expect(events[1].type).toBe('assistant_message');
  });
});

// ─── Transform tests ────────────────────────────────

describe('GenericAdapter transforms', () => {
  it('applies role_map to transform role names', async () => {
    const adapter = new GenericAdapter(TRANSFORM_YAML_PATH);
    const refs = await adapter.listNewSessions(new Date('2000-01-01'));
    const events: SessionEvent[] = [];
    for await (const ev of adapter.extractEvents(refs[0])) events.push(ev);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('user_message');    // human → user
    expect(events[1].type).toBe('assistant_message'); // bot → assistant
    expect(events[2].type).toBe('system');           // unknown_role not mapped → system
  });

  it('handles epoch_ms timestamp format', async () => {
    const adapter = new GenericAdapter(EPOCH_YAML_PATH);
    const refs = await adapter.listNewSessions(new Date('2000-01-01'));
    const events: SessionEvent[] = [];
    for await (const ev of adapter.extractEvents(refs[0])) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBeInstanceOf(Date);
    expect(events[0].timestamp.getFullYear()).toBe(2025);
  });
});

// ─── Error handling tests ───────────────────────────

describe('GenericAdapter error handling', () => {
  it('throws AdapterError for non-existent YAML file', () => {
    expect(() => new GenericAdapter('/tmp/does-not-exist.yaml')).toThrow();
  });

  it('skips malformed JSON lines gracefully', async () => {
    const dir = join(TMP, 'malformed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.jsonl'), 'not json\n{"role":"user","content":"ok","timestamp":"2026-01-01T00:00:00Z"}\n{broken\n');
    const yamlPath = join(TMP, 'malformed.yaml');
    writeFileSync(yamlPath, `runtime_id: mal\nworkspace_paths:\n  - ${dir}\nsession_format: jsonl\nfield_mapping:\n  role: $.role\n  content: $.content\n  timestamp: $.timestamp\n`);
    const adapter = new GenericAdapter(yamlPath);
    const refs = await adapter.listNewSessions(new Date('2000-01-01'));
    const events: SessionEvent[] = [];
    for await (const ev of adapter.extractEvents(refs[0])) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe('ok');
  });

  it('handles missing field paths gracefully', async () => {
    const dir = join(TMP, 'missing-field');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess.jsonl'), '{"foo":"bar"}\n');
    const yamlPath = join(TMP, 'missing-field.yaml');
    writeFileSync(yamlPath, `runtime_id: mf\nworkspace_paths:\n  - ${dir}\nsession_format: jsonl\nfield_mapping:\n  role: $.role\n  content: $.content\n`);
    const adapter = new GenericAdapter(yamlPath);
    const refs = await adapter.listNewSessions(new Date('2000-01-01'));
    const events: SessionEvent[] = [];
    for await (const ev of adapter.extractEvents(refs[0])) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system'); // role=unknown → system
    expect(events[0].content).toBe('');    // content not found → empty
  });
});

// ─── Codex YAML integration ─────────────────────────

describe('configs/adapters/codex.yaml', () => {
  it('loads and validates the codex YAML', () => {
    expect(existsSync(CODEX_YAML)).toBe(true);
    const adapter = new GenericAdapter(CODEX_YAML);
    expect(adapter.id).toBe('codex');
  });

  it('parses codex fixture with role transforms', async () => {
    // Create a temp workspace with the codex fixture
    const dir = join(TMP, 'codex-ws');
    mkdirSync(dir, { recursive: true });
    copyFileSync(CODEX_FIXTURE, join(dir, 'session-001.jsonl'));

    // Write a codex yaml pointing to temp dir
    const localYaml = join(TMP, 'codex-local.yaml');
    writeFileSync(localYaml, `
runtime_id: codex
workspace_paths:
  - ${dir}
session_format: jsonl
session_glob: "**/*.jsonl"
field_mapping:
  session_id: $.session_id
  message_id: $.id
  role: $.role
  content: $.content
  timestamp: $.ts
  part_type: $.type
transforms:
  role_map:
    human: user
    bot: assistant
    system: system
    tool: assistant
  timestamp_format: iso8601
`);

    const adapter = new GenericAdapter(localYaml);
    const refs = await adapter.listNewSessions(new Date('2000-01-01'));
    expect(refs.length).toBe(1);

    const events: SessionEvent[] = [];
    for await (const ev of adapter.extractEvents(refs[0])) events.push(ev);

    expect(events).toHaveLength(6);
    // human → user
    expect(events[0].type).toBe('user_message');
    expect(events[0].content).toBe('Explain the module system');
    // bot → assistant
    expect(events[1].type).toBe('assistant_message');
    // tool_call part_type
    expect(events[2].type).toBe('tool_call');
    // tool_result part_type
    expect(events[3].type).toBe('tool_result');
    // Last human message
    expect(events[5].type).toBe('user_message');
    expect(events[5].content).toBe('Thanks!');
  });
});
