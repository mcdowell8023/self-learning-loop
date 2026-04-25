/**
 * Workspace Detector — probes the local filesystem for known AI coding runtime workspaces.
 * Ref: self-learning-loop-skill-design-v1.1.md §4.3
 * @module
 */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const PROBES = [
    {
        runtime: 'openclaw',
        priority: 100,
        checks: [
            { path: '.openclaw/workspace', kind: 'dir', confidence: 0.6, isWorkspace: true },
            { path: '.openclaw/agents', kind: 'dir', confidence: 0.4, isAgentsRoot: true },
        ],
    },
    {
        runtime: 'claude-code',
        priority: 80,
        checks: [
            { path: '.claude/projects', kind: 'dir', confidence: 0.9, isWorkspace: true },
        ],
    },
    {
        runtime: 'opencode',
        priority: 60,
        checks: [
            { path: '.local/share/opencode/opencode.db', kind: 'file', confidence: 0.9, isWorkspace: true },
        ],
    },
    {
        runtime: 'codex',
        priority: 40,
        checks: [
            { path: '.codex', kind: 'dir', confidence: 0.7, isWorkspace: true },
        ],
    },
];
// ─── Core detection ─────────────────────────────────
/**
 * Detect all AI coding runtime workspaces on the current machine.
 * Returns results sorted by priority (highest first), filtering out
 * runtimes where no checks passed.
 *
 * @param homeOverride - Override homedir for testing.
 */
export async function detectWorkspaces(homeOverride) {
    const home = homeOverride ?? homedir();
    const results = [];
    for (const probe of PROBES) {
        let totalConfidence = 0;
        let workspacePath = '';
        let agentsRoot;
        for (const check of probe.checks) {
            const fullPath = join(home, check.path);
            if (pathExists(fullPath, check.kind)) {
                totalConfidence += check.confidence;
                if (check.isWorkspace)
                    workspacePath = fullPath;
                if (check.isAgentsRoot)
                    agentsRoot = fullPath;
            }
        }
        if (totalConfidence > 0 && workspacePath) {
            results.push({
                runtime: probe.runtime,
                workspacePath,
                ...(agentsRoot ? { agentsRoot } : {}),
                confidence: Math.min(totalConfidence, 1),
            });
        }
    }
    // Sort by priority (PROBES order is already priority-descending, but
    // re-sort explicitly for safety).
    const priorityMap = new Map(PROBES.map((p) => [p.runtime, p.priority]));
    results.sort((a, b) => (priorityMap.get(b.runtime) ?? 0) - (priorityMap.get(a.runtime) ?? 0));
    return results;
}
// ─── Helpers ────────────────────────────────────────
function pathExists(p, kind) {
    try {
        const s = statSync(p);
        return kind === 'dir' ? s.isDirectory() : s.isFile();
    }
    catch {
        return false;
    }
}
