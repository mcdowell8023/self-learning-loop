// src/e2e/test-helpers.ts
//
// E2E test setup/teardown + shared helpers.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCandidateStore } from '../store/candidate-store.js';
export const TEST_ENV = {
    runtime: 'openclaw-e2e',
    platform: 'linux',
    arch: 'x64',
    runtimeVersion: '0.1.0-e2e',
    model: 'mock-llm',
};
const AGENTS_TEMPLATE = `# AGENTS.md (E2E Test)

This is a test AGENTS.md file.

## Rules
- Be helpful
- Be safe
`;
export function setupE2E() {
    const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-'));
    const workspaceDir = join(tmpDir, 'workspace');
    mkdirSync(join(workspaceDir, 'learn'), { recursive: true });
    const agentsPath = join(workspaceDir, 'AGENTS.md');
    writeFileSync(agentsPath, AGENTS_TEMPLATE);
    const dbPath = join(workspaceDir, 'learn', 'candidates.db');
    const store = openCandidateStore({ dbPath, defaultActor: 'system' });
    const auditDir = join(workspaceDir, 'learn', 'audit');
    mkdirSync(auditDir, { recursive: true });
    return { tmpDir, workspaceDir, store, dbPath, agentsPath, auditDir };
}
export function teardownE2E(ctx) {
    try {
        ctx.store.close();
    }
    catch { /* ok */ }
    try {
        rmSync(ctx.tmpDir, { recursive: true, force: true });
    }
    catch { /* ok */ }
}
export function getAgentsMtime(ctx) {
    return statSync(ctx.agentsPath).mtimeMs;
}
export function readAgents(ctx) {
    return readFileSync(ctx.agentsPath, 'utf-8');
}
export function loadFixture(name) {
    const p = join(import.meta.dirname, 'fixtures', name);
    return JSON.parse(readFileSync(p, 'utf-8'));
}
export function makeEvents(raw) {
    return raw;
}
/** Read JSONL audit file and parse all lines. */
export function readAuditJsonl(path) {
    if (!existsSync(path))
        return [];
    return readFileSync(path, 'utf-8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => JSON.parse(l));
}
