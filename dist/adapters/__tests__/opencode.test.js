/**
 * OpencodeAdapter v2 — unit tests.
 * Uses in-memory SQLite via better-sqlite3 for fixtures.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OpencodeAdapter, computeContentHash } from '../opencode.js';
// ─── Helpers ────────────────────────────────────────
function createMockDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL DEFAULT '',
      directory TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '1',
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
    return db;
}
function insertSession(db, id, timeCreated, timeUpdated) {
    db.prepare(`INSERT INTO session (id, project_id, title, slug, directory, version, time_created, time_updated)
     VALUES (?, 'proj1', 'Test Session', 'test', '/tmp', '1', ?, ?)`).run(id, timeCreated, timeUpdated ?? timeCreated);
}
function insertMessage(db, id, sessionId, timeCreated, data) {
    db.prepare(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`).run(id, sessionId, timeCreated, timeCreated, JSON.stringify(data));
}
function insertPart(db, id, messageId, sessionId, timeCreated, data) {
    db.prepare(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`).run(id, messageId, sessionId, timeCreated, timeCreated, JSON.stringify(data));
}
// ─── Tests ──────────────────────────────────────────
describe('OpencodeAdapter', () => {
    let tmpDir;
    let dbPath;
    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'opencode-test-'));
        dbPath = join(tmpDir, 'opencode.db');
    });
    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });
    // ── detect ──────────────────────────────────────
    it('detect() returns false when DB does not exist', async () => {
        const adapter = new OpencodeAdapter({ dbPath: join(tmpDir, 'nonexistent.db') });
        expect(await adapter.detect()).toBe(false);
    });
    it('detect() returns true when DB exists', async () => {
        const db = createMockDb(dbPath);
        db.close();
        const adapter = new OpencodeAdapter({ dbPath });
        expect(await adapter.detect()).toBe(true);
    });
    // ── listNewSessions ─────────────────────────────
    it('listNewSessions returns sessions updated after since', async () => {
        const db = createMockDb(dbPath);
        insertSession(db, 'ses_old', 1000, 1000);
        insertSession(db, 'ses_new', 2000, 3000);
        insertSession(db, 'ses_newest', 2500, 4000);
        db.close();
        const adapter = new OpencodeAdapter({ dbPath });
        const refs = await adapter.listNewSessions(new Date(2500));
        expect(refs).toHaveLength(2);
        expect(refs[0].sessionId).toBe('ses_new');
        expect(refs[1].sessionId).toBe('ses_newest');
        await adapter.dispose();
    });
    // ── extractEvents ───────────────────────────────
    it('extractEvents converts text parts to SessionEvent correctly', async () => {
        const db = createMockDb(dbPath);
        insertSession(db, 'ses1', 1000);
        insertMessage(db, 'msg1', 'ses1', 1000, { role: 'user', time: { created: 1000 } });
        insertPart(db, 'prt1', 'msg1', 'ses1', 1001, { type: 'text', text: 'Hello world' });
        insertMessage(db, 'msg2', 'ses1', 2000, { role: 'assistant', time: { created: 2000 }, modelID: 'claude-opus-4.6' });
        insertPart(db, 'prt2', 'msg2', 'ses1', 2001, { type: 'text', text: 'Hi there' });
        insertPart(db, 'prt3', 'msg2', 'ses1', 2002, { type: 'step-finish', reason: 'stop' });
        db.close();
        const adapter = new OpencodeAdapter({ dbPath });
        const ref = { path: dbPath, runtime: 'opencode', sessionId: 'ses1', startedAt: new Date(1000), byteSize: 0 };
        const events = [];
        for await (const e of adapter.extractEvents(ref))
            events.push(e);
        expect(events).toHaveLength(2); // text parts only, step-finish skipped
        expect(events[0].type).toBe('user_message');
        expect(events[0].content).toBe('Hello world');
        expect(events[1].type).toBe('assistant_message');
        expect(events[1].content).toBe('Hi there');
        expect(events[1].metadata.modelID).toBe('claude-opus-4.6');
        await adapter.dispose();
    });
    it('extractEvents converts tool parts correctly', async () => {
        const db = createMockDb(dbPath);
        insertSession(db, 'ses1', 1000);
        insertMessage(db, 'msg1', 'ses1', 1000, { role: 'assistant' });
        insertPart(db, 'prt1', 'msg1', 'ses1', 1001, {
            type: 'tool', callID: 'call_1', tool: 'read',
            state: { status: 'completed', input: { path: '/tmp/x' }, output: 'file content' },
        });
        db.close();
        const adapter = new OpencodeAdapter({ dbPath });
        const ref = { path: dbPath, runtime: 'opencode', sessionId: 'ses1', startedAt: new Date(1000), byteSize: 0 };
        const events = [];
        for await (const e of adapter.extractEvents(ref))
            events.push(e);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('tool_result'); // completed → tool_result
        const parsed = JSON.parse(events[0].content);
        expect(parsed.tool).toBe('read');
        expect(parsed.status).toBe('completed');
        await adapter.dispose();
    });
    // ── contentHash ─────────────────────────────────
    it('computeContentHash produces correct deterministic hash', () => {
        const hash = computeContentHash('user_message', 'Hello world');
        // SHA256("user_message:Hello world") first 32 hex chars
        expect(hash).toHaveLength(32);
        expect(hash).toMatch(/^[0-9a-f]{32}$/);
        // Deterministic
        expect(computeContentHash('user_message', 'Hello world')).toBe(hash);
        // Different input → different hash
        expect(computeContentHash('assistant_message', 'Hello world')).not.toBe(hash);
    });
    // ── ACP guard ───────────────────────────────────
    it('ACP is not activated when acpEnabled is false (default)', async () => {
        const db = createMockDb(dbPath);
        db.close();
        const adapter = new OpencodeAdapter({ dbPath, acpEnabled: false });
        // Adapter should work in pure SQLite mode — healthCheck should succeed
        const health = await adapter.healthCheck();
        expect(health.ok).toBe(true);
        const fp = await adapter.getEnvFingerprint();
        expect(fp.extensions?.acpEnabled).toBe(false);
        await adapter.dispose();
    });
    // ── healthCheck ─────────────────────────────────
    it('healthCheck returns ok with session count', async () => {
        const db = createMockDb(dbPath);
        insertSession(db, 'ses1', 1000);
        insertSession(db, 'ses2', 2000);
        db.close();
        const adapter = new OpencodeAdapter({ dbPath });
        const health = await adapter.healthCheck();
        expect(health.ok).toBe(true);
        expect(health.message).toContain('2');
        await adapter.dispose();
    });
});
