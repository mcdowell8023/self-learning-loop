/**
 * ClaudeCodeAdapter — unit tests.
 * Covers T-SLL-002c: fallback detection, dry-run, session listing, event extraction.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, detectClaudeCodeWithDryRun } from '../claude-code.js';
let tmpRoot;
beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'claude-code-test-'));
});
afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
});
describe('ClaudeCodeAdapter', () => {
    // ─── detect() ───────────────────────────────────
    it('detect() returns false when no candidate paths exist', async () => {
        const adapter = new ClaudeCodeAdapter({ projectsRoot: join(tmpRoot, 'nonexistent') });
        // projectsRoot is set but doesn't exist, and CANDIDATE_PATHS won't match tmpRoot
        expect(await adapter.detect()).toBe(false);
    });
    it('detect() returns true when projectsRoot exists', async () => {
        const projectsDir = join(tmpRoot, 'projects');
        mkdirSync(projectsDir, { recursive: true });
        const adapter = new ClaudeCodeAdapter({ projectsRoot: projectsDir });
        expect(await adapter.detect()).toBe(true);
    });
    // ─── detectClaudeCodeWithDryRun() ───────────────
    it('dry-run returns hint when no paths exist', async () => {
        const result = await detectClaudeCodeWithDryRun([
            join(tmpRoot, 'a'),
            join(tmpRoot, 'b'),
        ]);
        expect(result.success).toBe(false);
        expect(result.triedPaths).toHaveLength(2);
        expect(result.hint).toContain('安装');
    });
    it('dry-run returns hint when directory is empty', async () => {
        const emptyDir = join(tmpRoot, 'empty-projects');
        mkdirSync(emptyDir, { recursive: true });
        const result = await detectClaudeCodeWithDryRun([emptyDir]);
        expect(result.success).toBe(false);
        expect(result.hint).toContain('session');
    });
    it('dry-run succeeds when projects exist', async () => {
        const projectsDir = join(tmpRoot, 'projects');
        mkdirSync(join(projectsDir, 'my-project'), { recursive: true });
        const result = await detectClaudeCodeWithDryRun([projectsDir]);
        expect(result.success).toBe(true);
        expect(result.detectedPath).toBe(projectsDir);
    });
    // ─── listNewSessions() ─────────────────────────
    it('listNewSessions returns [] for empty projects dir', async () => {
        const projectsDir = join(tmpRoot, 'projects');
        mkdirSync(projectsDir, { recursive: true });
        const adapter = new ClaudeCodeAdapter({ projectsRoot: projectsDir });
        await adapter.detect();
        const refs = await adapter.listNewSessions(new Date(0));
        expect(refs).toEqual([]);
    });
    it('listNewSessions finds jsonl files', async () => {
        const sessionsDir = join(tmpRoot, 'projects', 'proj1', 'sessions');
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, 'session1.jsonl'), '{"role":"user","content":"hello","timestamp":"2026-01-01T00:00:00Z"}\n');
        const adapter = new ClaudeCodeAdapter({ projectsRoot: join(tmpRoot, 'projects') });
        await adapter.detect();
        const refs = await adapter.listNewSessions(new Date(0));
        expect(refs).toHaveLength(1);
        expect(refs[0].sessionId).toBe('session1');
        expect(refs[0].runtime).toBe('claude-code');
    });
    // ─── extractEvents() ───────────────────────────
    it('extractEvents parses mock jsonl correctly', async () => {
        const sessionsDir = join(tmpRoot, 'projects', 'proj1', 'sessions');
        mkdirSync(sessionsDir, { recursive: true });
        const filePath = join(sessionsDir, 'sess.jsonl');
        const lines = [
            JSON.stringify({ role: 'user', content: 'What is 1+1?', timestamp: '2026-01-01T00:00:00Z' }),
            JSON.stringify({ role: 'assistant', content: '2', timestamp: '2026-01-01T00:00:01Z' }),
            JSON.stringify({ role: 'tool_use', content: '{"name":"calc"}', timestamp: '2026-01-01T00:00:02Z' }),
        ];
        writeFileSync(filePath, lines.join('\n') + '\n');
        const adapter = new ClaudeCodeAdapter({ projectsRoot: join(tmpRoot, 'projects') });
        await adapter.detect();
        const refs = await adapter.listNewSessions(new Date(0));
        const events = [];
        for await (const event of adapter.extractEvents(refs[0])) {
            events.push(event);
        }
        expect(events).toHaveLength(3);
        expect(events[0].type).toBe('user_message');
        expect(events[0].content).toBe('What is 1+1?');
        expect(events[1].type).toBe('assistant_message');
        expect(events[2].type).toBe('tool_call');
    });
    // ─── healthCheck() ─────────────────────────────
    it('healthCheck returns unhealthy with hint when not detected', async () => {
        const adapter = new ClaudeCodeAdapter({ projectsRoot: join(tmpRoot, 'nope') });
        const result = await adapter.healthCheck();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('dry-run');
    });
});
