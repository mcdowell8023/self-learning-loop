/**
 * OpencodeAdapter v2 — collects session events from opencode's SQLite database.
 * Actual DB: `~/.local/share/opencode/opencode.db` (Drizzle ORM schema).
 *
 * Real schema (explored 2026-04-25):
 *   session(id, project_id, title, time_created, time_updated, ...)
 *   message(id, session_id, time_created, time_updated, data JSON)
 *   part(id, message_id, session_id, time_created, time_updated, data JSON)
 *
 * Message `data` JSON contains: { role, time, modelID, providerID, tokens, ... }
 * Part `data` JSON contains: { type: "text"|"tool"|"reasoning"|"step-start"|"step-finish"|"compaction", ... }
 *   - text parts: { type:"text", text:"..." }
 *   - tool parts: { type:"tool", callID, tool, state:{ status, input, output, ... } }
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AdapterError } from './base.js';
// ─── Helpers ────────────────────────────────────────
/** §4.4.2 contentHash: SHA256(type + ":" + content).slice(0,32) */
export function computeContentHash(type, content) {
    return createHash('sha256').update(`${type}:${content}`).digest('hex').slice(0, 32);
}
/** Default DB path. */
const DEFAULT_DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
// ─── Adapter ────────────────────────────────────────
export class OpencodeAdapter {
    options;
    id = 'opencode';
    displayName = 'Opencode';
    version = '2.0.0';
    db;
    dbPath;
    acpEnabled;
    constructor(options = {}) {
        this.options = options;
        this.dbPath = options.dbPath ?? DEFAULT_DB_PATH;
        this.acpEnabled = options.acpEnabled ?? false;
    }
    // ─── detect ─────────────────────────────────────
    async detect() {
        try {
            return existsSync(this.dbPath) && statSync(this.dbPath).isFile();
        }
        catch {
            return false;
        }
    }
    // ─── listNewSessions ────────────────────────────
    async listNewSessions(since) {
        const db = this.getDb();
        const sinceMs = since.getTime();
        const rows = db.prepare(`SELECT id, project_id, title, time_created, time_updated
       FROM session
       WHERE time_updated >= ?
       ORDER BY time_updated ASC`).all(sinceMs);
        return rows.map((row) => ({
            path: this.dbPath,
            runtime: this.id,
            sessionId: row.id,
            startedAt: new Date(row.time_created),
            byteSize: 0, // not meaningful for SQLite rows
            metadata: {
                projectId: row.project_id,
                title: row.title,
                timeUpdated: row.time_updated,
            },
        }));
    }
    // ─── extractEvents ──────────────────────────────
    async *extractEvents(ref) {
        const db = this.getDb();
        const sessionId = ref.sessionId;
        // Get messages ordered by creation time
        const messages = db.prepare(`SELECT id, session_id, time_created, data
       FROM message
       WHERE session_id = ?
       ORDER BY time_created ASC`).all(sessionId);
        for (const msg of messages) {
            let msgData;
            try {
                msgData = JSON.parse(msg.data);
            }
            catch {
                throw new AdapterError(`Failed to parse message data: ${msg.id}`, this.id);
            }
            // Get parts for this message
            const parts = db.prepare(`SELECT id, message_id, session_id, time_created, data
         FROM part
         WHERE message_id = ?
         ORDER BY time_created ASC`).all(msg.id);
            if (parts.length === 0) {
                // Message with no parts — emit a bare event from message role
                const eventType = mapRoleToEventType(msgData.role);
                const content = '';
                yield {
                    type: eventType,
                    timestamp: new Date(msg.time_created),
                    content,
                    contentHash: computeContentHash(eventType, content),
                    metadata: {
                        messageId: msg.id,
                        sessionId,
                        role: msgData.role,
                        modelID: msgData.modelID,
                        providerID: msgData.providerID,
                    },
                };
                continue;
            }
            // Yield one event per meaningful part (skip step-start/step-finish)
            for (const part of parts) {
                let partData;
                try {
                    partData = JSON.parse(part.data);
                }
                catch {
                    throw new AdapterError(`Failed to parse part data: ${part.id}`, this.id);
                }
                const event = this.partToEvent(partData, part, msg, msgData, sessionId);
                if (event)
                    yield event;
            }
        }
    }
    // ─── getEnvFingerprint ──────────────────────────
    async getEnvFingerprint() {
        return {
            runtime: 'opencode',
            platform: platform(),
            arch: arch(),
            extensions: {
                dbPath: this.dbPath,
                acpEnabled: this.acpEnabled,
            },
        };
    }
    // ─── healthCheck ────────────────────────────────
    async healthCheck() {
        try {
            const db = this.getDb();
            const row = db.prepare('SELECT count(*) as c FROM session').get();
            return { ok: true, message: `${row?.c ?? 0} sessions` };
        }
        catch (e) {
            return { ok: false, message: String(e) };
        }
    }
    // ─── dispose ────────────────────────────────────
    async dispose() {
        if (this.db) {
            this.db.close();
            this.db = undefined;
        }
    }
    // ─── Private helpers ────────────────────────────
    getDb() {
        if (!this.db) {
            try {
                this.db = new Database(this.dbPath, { readonly: true });
            }
            catch (e) {
                throw new AdapterError(`Cannot open DB: ${this.dbPath}`, this.id, e);
            }
        }
        return this.db;
    }
    partToEvent(partData, part, msg, msgData, sessionId) {
        const baseMetadata = {
            messageId: msg.id,
            partId: part.id,
            sessionId,
            role: msgData.role,
            modelID: msgData.modelID,
            providerID: msgData.providerID,
        };
        switch (partData.type) {
            case 'text': {
                const text = partData.text ?? '';
                const eventType = mapRoleToEventType(msgData.role);
                return {
                    type: eventType,
                    timestamp: new Date(part.time_created),
                    content: text,
                    contentHash: computeContentHash(eventType, text),
                    metadata: baseMetadata,
                };
            }
            case 'tool': {
                const toolData = partData;
                const status = toolData.state?.status ?? 'unknown';
                const toolName = toolData.tool ?? 'unknown';
                const content = JSON.stringify({
                    tool: toolName,
                    callID: toolData.callID,
                    status,
                    input: toolData.state?.input,
                    output: toolData.state?.output,
                });
                // tool invocations from assistant are tool_call; completed results are tool_result
                const eventType = status === 'completed' ? 'tool_result' : 'tool_call';
                return {
                    type: eventType,
                    timestamp: new Date(part.time_created),
                    content,
                    contentHash: computeContentHash(eventType, content),
                    metadata: { ...baseMetadata, toolName, callID: toolData.callID },
                };
            }
            case 'reasoning': {
                const text = partData.text ?? '';
                if (!text)
                    return null;
                return {
                    type: 'system',
                    timestamp: new Date(part.time_created),
                    content: text,
                    contentHash: computeContentHash('system', text),
                    metadata: { ...baseMetadata, subtype: 'reasoning' },
                };
            }
            // Skip step-start, step-finish, compaction — infrastructure signals
            default:
                return null;
        }
    }
}
// ─── Utility ────────────────────────────────────────
function mapRoleToEventType(role) {
    switch (role) {
        case 'user': return 'user_message';
        case 'assistant': return 'assistant_message';
        case 'system': return 'system';
        default: return role;
    }
}
