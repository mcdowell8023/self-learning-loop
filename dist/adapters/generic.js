import { existsSync, readFileSync, createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse as parseYaml } from 'yaml';
import { AdapterError } from './base.js';
import { GenericMappingSchema } from './generic-schema.js';
// ─── Helpers ────────────────────────────────────────
/** Expand `~` at the start of a path. */
function expandHome(p) {
    return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}
/** Minimal JSONPath field extraction: supports `$.field` and `$.nested.field`. */
function extractField(obj, path) {
    if (!path.startsWith('$.'))
        return undefined;
    const keys = path.slice(2).split('.');
    let cur = obj;
    for (const k of keys) {
        if (cur == null || typeof cur !== 'object')
            return undefined;
        cur = cur[k];
    }
    return cur;
}
/** Simple glob match for patterns like `**\/*.jsonl`. */
function matchGlob(filename, pattern) {
    if (pattern.startsWith('**/')) {
        const suffix = pattern.slice(3); // e.g. "*.jsonl"
        return matchSimple(filename, suffix);
    }
    return matchSimple(filename, pattern);
}
function matchSimple(filename, pattern) {
    if (pattern.startsWith('*.')) {
        return filename.endsWith(pattern.slice(1));
    }
    return filename === pattern;
}
// ─── GenericAdapter ─────────────────────────────────
export class GenericAdapter {
    id;
    displayName;
    version = '1.0.0';
    mapping;
    resolvedPaths;
    constructor(yamlMappingPath) {
        const raw = readFileSync(yamlMappingPath, 'utf-8');
        const parsed = parseYaml(raw);
        const result = GenericMappingSchema.safeParse(parsed);
        if (!result.success) {
            throw new AdapterError(`Invalid YAML mapping: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'generic');
        }
        this.mapping = result.data;
        this.id = this.mapping.runtime_id;
        this.displayName = `Generic (${this.mapping.runtime_id})`;
        this.resolvedPaths = this.mapping.workspace_paths.map(p => expandHome(p));
    }
    async detect() {
        return this.resolvedPaths.some(p => existsSync(p));
    }
    async listNewSessions(since) {
        const refs = [];
        const glob = this.mapping.session_glob ?? '**/*.jsonl';
        for (const wsPath of this.resolvedPaths) {
            if (!existsSync(wsPath))
                continue;
            let entries;
            try {
                entries = await readdir(wsPath, { recursive: true });
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (!matchGlob(entry, glob))
                    continue;
                const fullPath = join(wsPath, entry);
                try {
                    const st = await stat(fullPath);
                    if (st.mtime < since)
                        continue;
                    refs.push({
                        path: fullPath,
                        runtime: this.id,
                        sessionId: basename(fullPath, '.jsonl'),
                        startedAt: st.birthtime,
                        byteSize: st.size,
                    });
                }
                catch {
                    // skip unreadable files
                }
            }
        }
        return refs;
    }
    async *extractEvents(ref) {
        const format = this.mapping.session_format;
        if (format !== 'jsonl') {
            throw new AdapterError(`Session format "${format}" not yet implemented in GenericAdapter`, this.id);
        }
        const fm = this.mapping.field_mapping;
        const rl = createInterface({ input: createReadStream(ref.path, 'utf-8') });
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            let record;
            try {
                record = JSON.parse(trimmed);
            }
            catch {
                continue; // skip malformed lines
            }
            const role = fm ? String(extractField(record, fm.role) ?? 'unknown') : 'unknown';
            const content = fm ? String(extractField(record, fm.content) ?? '') : JSON.stringify(record);
            const tsRaw = fm?.timestamp ? extractField(record, fm.timestamp) : undefined;
            const timestamp = tsRaw ? new Date(String(tsRaw)) : new Date();
            const eventType = role === 'user' ? 'user_message'
                : role === 'assistant' ? 'assistant_message'
                    : 'system';
            yield {
                type: eventType,
                timestamp,
                content,
                metadata: { runtime: this.id, sessionId: ref.sessionId },
                raw: record,
            };
        }
    }
    async getEnvFingerprint() {
        return {
            runtime: this.id,
            runtimeVersion: this.version,
            platform: process.platform,
            arch: process.arch,
        };
    }
    async healthCheck() {
        const detected = await this.detect();
        return {
            ok: detected,
            message: detected ? `${this.id} workspace found` : `No workspace paths exist`,
        };
    }
    async dispose() {
        // No resources to release
    }
}
