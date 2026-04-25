/**
 * OpenClawAdapter — collects session events from `~/.openclaw/agents/＊/sessions/＊.jsonl`.
 * Ref: learning-loop-design-v5.0.3.md §4.2.1 & §4.4
 * @module
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, createReadStream, } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { AdapterError } from './base.js';
// ─── Helpers (exported for testing) ─────────────────
const DEDUP_WINDOW_MS = 30_000;
/** §4.4.2 — SHA-256(type ":" content) truncated to 32 hex chars (128 bit). */
export function computeContentHash(event) {
    return createHash('sha256')
        .update(`${String(event.type)}:${event.content}`)
        .digest('hex')
        .slice(0, 32);
}
/** §4.4.2 — richness scoring used for cross-runtime dedup tie-breaking. */
export function envRichnessScore(env) {
    if (!env)
        return 0;
    let score = 0;
    if (env.runtime)
        score += 1;
    if (env.platform)
        score += 1;
    if (env.arch)
        score += 1;
    if (env.model)
        score += 1;
    if (env.runtimeVersion)
        score += 1;
    if (env.nodeVersion)
        score += 1;
    const ext = env.extensions;
    if (ext && typeof ext === 'object') {
        score += Object.keys(ext).length;
    }
    return score;
}
/** §4.4.2 — prefer the event whose env_fingerprint is richer; tie → newer timestamp. */
export function preferRicherEnv(existing, incoming) {
    const a = envRichnessScore(existing.env_fingerprint);
    const b = envRichnessScore(incoming.env_fingerprint);
    if (b > a)
        return incoming;
    if (b < a)
        return existing;
    const ta = existing.timestamp instanceof Date ? existing.timestamp.getTime() : 0;
    const tb = incoming.timestamp instanceof Date ? incoming.timestamp.getTime() : 0;
    return tb > ta ? incoming : existing;
}
/** §4.4.2 — dedup events within a 30s window; richer env wins on collision. */
export function deduplicateEvents(events, seen = new Map()) {
    const result = [];
    for (const event of events) {
        const hash = event.contentHash ?? computeContentHash(event);
        event.contentHash = hash;
        const prev = seen.get(hash);
        if (prev &&
            Math.abs(event.timestamp.getTime() - prev.date.getTime()) < DEDUP_WINDOW_MS) {
            const preferred = preferRicherEnv(prev.event, event);
            if (preferred !== prev.event) {
                const idx = result.indexOf(prev.event);
                if (idx >= 0)
                    result[idx] = preferred;
                seen.set(hash, { date: event.timestamp, event: preferred });
            }
            continue;
        }
        seen.set(hash, { date: event.timestamp, event });
        result.push(event);
    }
    return result;
}
/**
 * OpenClawAdapter parses OpenClaw's JSONL session transcripts.
 *
 * ```
 * ~/.openclaw/
 *   sessions/＊.jsonl                     ← legacy layout (design doc §4.2.1)
 *   agents/<agent>/sessions/＊.jsonl      ← current layout (OpenClaw 2026.x)
 * ```
 *
 * The adapter auto-detects the active layout at construction time.
 */
export class OpenClawAdapter {
    id = 'openclaw';
    displayName = 'OpenClaw';
    version = '1.0.0';
    extendedEventTypes = ['thinking', 'model_change', 'session', 'custom'];
    sessionsDir;
    recursive;
    stateFilePath;
    auditSink;
    model;
    /** sessionId → last byte offset read. Loaded from disk at construction. */
    offsets = new Map();
    constructor(opts = {}) {
        this.sessionsDir = opts.sessionsDir ?? OpenClawAdapter.defaultSessionsDir();
        this.recursive = opts.recursive ?? true;
        const workspace = opts.workspaceDir ?? join(homedir(), '.openclaw', 'workspace');
        this.stateFilePath =
            opts.stateFilePath ?? join(workspace, 'learn', 'config', 'collect-state.json');
        this.auditSink = opts.auditSink;
        this.model = opts.model;
        this.loadPersistedOffsets();
    }
    static defaultSessionsDir() {
        const legacy = join(homedir(), '.openclaw', 'sessions');
        if (existsSync(legacy))
            return legacy;
        const modern = join(homedir(), '.openclaw', 'agents');
        return modern;
    }
    // ── Offset persistence ────────────────────────────
    loadPersistedOffsets() {
        try {
            const raw = readFileSync(this.stateFilePath, 'utf-8');
            const state = JSON.parse(raw);
            for (const [k, v] of Object.entries(state.offsets ?? {})) {
                if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
                    this.offsets.set(k, v);
                }
            }
        }
        catch {
            /* first run, no state file */
        }
    }
    /** Persist the in-memory offset map to disk (atomic write). */
    flushOffsets() {
        try {
            mkdirSync(dirname(this.stateFilePath), { recursive: true });
            const payload = JSON.stringify({ offsets: Object.fromEntries(this.offsets) }, null, 2);
            const tmp = `${this.stateFilePath}.tmp`;
            writeFileSync(tmp, payload, 'utf-8');
            // renameSync is atomic on same filesystem.
            renameSync(tmp, this.stateFilePath);
        }
        catch (err) {
            this.emitAudit('offset_flush_failed', {
                state_file: this.stateFilePath,
                error: err.message,
            });
        }
    }
    /** Test hook: inspect in-memory offsets. */
    getOffset(sessionId) {
        return this.offsets.get(sessionId);
    }
    // ── RuntimeAdapter ────────────────────────────────
    async detect() {
        try {
            const files = await this.discoverJsonlFiles();
            return files.length > 0;
        }
        catch {
            return false;
        }
    }
    async listNewSessions(since) {
        let files;
        try {
            files = await this.discoverJsonlFiles();
        }
        catch (err) {
            throw new AdapterError(`failed to list sessions in ${this.sessionsDir}`, this.id, err);
        }
        const refs = [];
        for (const fullPath of files) {
            try {
                const st = await stat(fullPath);
                if (st.mtimeMs < since.getTime())
                    continue;
                const sessionId = basename(fullPath, '.jsonl');
                refs.push({
                    path: fullPath,
                    runtime: this.id,
                    sessionId,
                    startedAt: st.birthtime && st.birthtime.getTime() > 0 ? st.birthtime : st.mtime,
                    byteSize: st.size,
                    lastOffset: this.offsets.get(sessionId) ?? 0,
                });
            }
            catch (err) {
                this.emitAudit('stat_failed', { path: fullPath, error: err.message });
            }
        }
        return refs;
    }
    async *extractEvents(ref) {
        const startOffset = ref.lastOffset ?? 0;
        const stream = createReadStream(ref.path, {
            start: startOffset,
            encoding: 'utf-8',
        });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        let bytesRead = startOffset;
        let lineNo = 0;
        try {
            for await (const line of rl) {
                lineNo += 1;
                // Each line consumes its bytes + 1 for '\n'. We charge even for skipped
                // lines so offsets stay consistent across resumes.
                bytesRead += Buffer.byteLength(line, 'utf-8') + 1;
                if (!line.trim())
                    continue;
                let raw;
                try {
                    raw = JSON.parse(line);
                }
                catch (err) {
                    this.emitAudit('malformed_line_skipped', {
                        session_id: ref.sessionId,
                        path: ref.path,
                        line_no: lineNo,
                        error: err.message,
                    });
                    continue;
                }
                try {
                    yield* this.toSessionEvents(raw, ref);
                }
                catch (err) {
                    this.emitAudit('event_mapping_failed', {
                        session_id: ref.sessionId,
                        path: ref.path,
                        line_no: lineNo,
                        error: err.message,
                    });
                }
            }
        }
        finally {
            this.offsets.set(ref.sessionId, bytesRead);
        }
    }
    async getEnvFingerprint() {
        return {
            runtime: 'openclaw',
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
            ...(this.model ? { model: this.model } : {}),
        };
    }
    async healthCheck() {
        const ok = existsSync(this.sessionsDir);
        return ok
            ? { ok: true }
            : { ok: false, message: `sessions dir not found: ${this.sessionsDir}` };
    }
    async dispose() {
        this.flushOffsets();
    }
    // ── Internals ─────────────────────────────────────
    /** Walks sessionsDir (1 level deep if `recursive`) collecting `＊.jsonl` files. */
    async discoverJsonlFiles() {
        if (!existsSync(this.sessionsDir))
            return [];
        const out = [];
        const top = await readdir(this.sessionsDir, { withFileTypes: true });
        for (const entry of top) {
            const p = join(this.sessionsDir, entry.name);
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                out.push(p);
            }
            else if (entry.isDirectory() && this.recursive) {
                // Support `agents/<agent>/sessions/*.jsonl` pattern. Descend one more level.
                try {
                    const sub = await readdir(p, { withFileTypes: true });
                    for (const s of sub) {
                        const sp = join(p, s.name);
                        if (s.isFile() && s.name.endsWith('.jsonl')) {
                            out.push(sp);
                        }
                        else if (s.isDirectory() && s.name === 'sessions') {
                            const leaf = await readdir(sp);
                            for (const f of leaf) {
                                if (f.endsWith('.jsonl'))
                                    out.push(join(sp, f));
                            }
                        }
                    }
                }
                catch {
                    /* unreadable subdir — skip silently */
                }
            }
        }
        return out;
    }
    /**
     * Convert one raw OpenClaw JSONL record into 0..N SessionEvents.
     * OpenClaw wraps chat turns in `{type:"message", message:{role, content:[...]}}`
     * where `content` is an array of parts — each `tool_use` / `tool_result` /
     * `text` / `thinking` part becomes its own SessionEvent.
     */
    *toSessionEvents(raw, ref) {
        const ts = this.parseTimestamp(raw);
        const rawType = typeof raw['type'] === 'string' ? raw['type'] : 'system';
        const commonMeta = {
            session_id: ref.sessionId,
            runtime: this.id,
            raw_id: typeof raw['id'] === 'string' ? raw['id'] : undefined,
            parent_id: typeof raw['parentId'] === 'string' ? raw['parentId'] : undefined,
        };
        if (rawType === 'message') {
            const message = raw['message'];
            const role = typeof message?.['role'] === 'string' ? message['role'] : 'system';
            const content = Array.isArray(message?.['content']) ? message['content'] : [];
            if (content.length === 0) {
                const text = typeof message?.['content'] === 'string' ? message['content'] : '';
                yield this.buildEvent({
                    type: this.mapRoleToType(role),
                    timestamp: ts,
                    content: text,
                    metadata: { ...commonMeta, role },
                    raw,
                });
                return;
            }
            for (const partUnknown of content) {
                const part = partUnknown;
                const partType = typeof part['type'] === 'string' ? part['type'] : 'text';
                if (partType === 'text') {
                    yield this.buildEvent({
                        type: this.mapRoleToType(role),
                        timestamp: ts,
                        content: typeof part['text'] === 'string' ? part['text'] : '',
                        metadata: { ...commonMeta, role, part: 'text' },
                        raw: part,
                    });
                }
                else if (partType === 'thinking') {
                    yield this.buildEvent({
                        type: 'thinking',
                        timestamp: ts,
                        content: typeof part['thinking'] === 'string' ? part['thinking'] : '',
                        metadata: { ...commonMeta, role, part: 'thinking' },
                        raw: part,
                    });
                }
                else if (partType === 'tool_use') {
                    const input = part['input'];
                    yield this.buildEvent({
                        type: 'tool_call',
                        timestamp: ts,
                        content: typeof input === 'string' ? input : input != null ? JSON.stringify(input) : '',
                        metadata: {
                            ...commonMeta,
                            role,
                            tool_name: typeof part['name'] === 'string' ? part['name'] : undefined,
                            tool_call_id: typeof part['id'] === 'string' ? part['id'] : undefined,
                        },
                        raw: part,
                    });
                }
                else if (partType === 'tool_result') {
                    const c = part['content'];
                    yield this.buildEvent({
                        type: 'tool_result',
                        timestamp: ts,
                        content: typeof c === 'string' ? c : c != null ? JSON.stringify(c) : '',
                        metadata: {
                            ...commonMeta,
                            role,
                            tool_call_id: typeof part['tool_use_id'] === 'string' ? part['tool_use_id'] : undefined,
                        },
                        raw: part,
                    });
                }
                else {
                    // Unknown part — passthrough as extended event; never crash.
                    yield this.buildEvent({
                        type: partType,
                        timestamp: ts,
                        content: typeof part['text'] === 'string'
                            ? part['text']
                            : JSON.stringify(part),
                        metadata: { ...commonMeta, role, part: partType },
                        raw: part,
                    });
                }
            }
            return;
        }
        // Non-message system-level events (session / model_change / custom / …).
        // Keep them as extended events so downstream analysis has full context.
        const content = this.stringifySystemEvent(raw);
        yield this.buildEvent({
            type: rawType,
            timestamp: ts,
            content,
            metadata: { ...commonMeta },
            raw,
        });
    }
    buildEvent(input) {
        // Strip undefined metadata keys for cleaner JSON.
        const metadata = {};
        for (const [k, v] of Object.entries(input.metadata)) {
            if (v !== undefined)
                metadata[k] = v;
        }
        const evt = {
            type: input.type,
            timestamp: input.timestamp,
            content: input.content,
            metadata,
            raw: input.raw,
        };
        evt.contentHash = computeContentHash(evt);
        return evt;
    }
    mapRoleToType(role) {
        switch (role) {
            case 'user':
            case 'human':
                return 'user_message';
            case 'assistant':
                return 'assistant_message';
            case 'tool':
                return 'tool_result';
            case 'system':
                return 'system';
            default:
                return 'system';
        }
    }
    parseTimestamp(raw) {
        const candidates = [raw['timestamp'], raw['ts'], raw['time']];
        for (const c of candidates) {
            if (typeof c === 'string' || typeof c === 'number') {
                const d = new Date(c);
                if (!Number.isNaN(d.getTime()))
                    return d;
            }
        }
        return new Date(0);
    }
    stringifySystemEvent(raw) {
        // Stable-ish string for hashing — strip volatile id fields.
        const { id: _id, parentId: _p, ...rest } = raw;
        try {
            return JSON.stringify(rest);
        }
        catch {
            return String(raw['type'] ?? '');
        }
    }
    emitAudit(type, data, summary) {
        if (!this.auditSink)
            return;
        const evt = {
            event_id: randomUUID(),
            type: `adapter.${type}`,
            timestamp: new Date().toISOString(),
            actor: this.id,
            data,
            summary,
        };
        try {
            this.auditSink(evt);
        }
        catch {
            /* audit sink must never break the pipeline */
        }
    }
}
