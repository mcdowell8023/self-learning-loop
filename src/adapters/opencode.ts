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

import type { EnvFingerprint, SessionEvent, SessionRef } from '../kernel/schemas/session.js';
import { AdapterError, type RuntimeAdapter } from './base.js';

// ─── Config ─────────────────────────────────────────

export interface OpencodeAdapterOptions {
  /** Override DB path (for testing). */
  dbPath?: string;
  /** ACP protocol toggle — default false (SQLite-only). */
  acpEnabled?: boolean;
  /** ACP port (only used when acpEnabled=true). */
  acpPort?: number;
}

// ─── Helpers ────────────────────────────────────────

/** §4.4.2 contentHash: SHA256(type + ":" + content).slice(0,32) */
export function computeContentHash(type: string, content: string): string {
  return createHash('sha256').update(`${type}:${content}`).digest('hex').slice(0, 32);
}

/** Default DB path. */
const DEFAULT_DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

// ─── Part data shapes ───────────────────────────────

interface PartDataText {
  type: 'text';
  text: string;
}

interface PartDataTool {
  type: 'tool';
  callID?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: unknown; title?: string };
}

interface PartDataReasoning {
  type: 'reasoning';
  text?: string;
}

type PartData = PartDataText | PartDataTool | PartDataReasoning | { type: string };

interface MessageData {
  role: string;
  time?: { created?: number; completed?: number };
  modelID?: string;
  providerID?: string;
  tokens?: { total?: number; input?: number; output?: number };
}

// ─── Raw row types ──────────────────────────────────

interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

// ─── Adapter ────────────────────────────────────────

export class OpencodeAdapter implements RuntimeAdapter {
  readonly id = 'opencode';
  readonly displayName = 'Opencode';
  readonly version = '2.0.0';

  private db?: Database.Database;
  private readonly dbPath: string;
  private readonly acpEnabled: boolean;

  constructor(private readonly options: OpencodeAdapterOptions = {}) {
    this.dbPath = options.dbPath ?? DEFAULT_DB_PATH;
    this.acpEnabled = options.acpEnabled ?? false;
  }

  // ─── detect ─────────────────────────────────────

  async detect(): Promise<boolean> {
    try {
      return existsSync(this.dbPath) && statSync(this.dbPath).isFile();
    } catch {
      return false;
    }
  }

  // ─── listNewSessions ────────────────────────────

  async listNewSessions(since: Date): Promise<SessionRef[]> {
    const db = this.getDb();
    const sinceMs = since.getTime();

    const rows = db.prepare(
      `SELECT id, project_id, title, time_created, time_updated
       FROM session
       WHERE time_updated >= ?
       ORDER BY time_updated ASC`,
    ).all(sinceMs) as SessionRow[];

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

  async *extractEvents(ref: SessionRef): AsyncIterable<SessionEvent> {
    const db = this.getDb();
    const sessionId = ref.sessionId;

    // Get messages ordered by creation time
    const messages = db.prepare(
      `SELECT id, session_id, time_created, data
       FROM message
       WHERE session_id = ?
       ORDER BY time_created ASC`,
    ).all(sessionId) as MessageRow[];

    for (const msg of messages) {
      let msgData: MessageData;
      try {
        msgData = JSON.parse(msg.data) as MessageData;
      } catch {
        throw new AdapterError(`Failed to parse message data: ${msg.id}`, this.id);
      }

      // Get parts for this message
      const parts = db.prepare(
        `SELECT id, message_id, session_id, time_created, data
         FROM part
         WHERE message_id = ?
         ORDER BY time_created ASC`,
      ).all(msg.id) as PartRow[];

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
        let partData: PartData;
        try {
          partData = JSON.parse(part.data) as PartData;
        } catch {
          throw new AdapterError(`Failed to parse part data: ${part.id}`, this.id);
        }

        const event = this.partToEvent(partData, part, msg, msgData, sessionId);
        if (event) yield event;
      }
    }
  }

  // ─── getEnvFingerprint ──────────────────────────

  async getEnvFingerprint(): Promise<EnvFingerprint> {
    return {
      runtime: 'opencode',
      platform: platform() as 'linux' | 'darwin' | 'win32',
      arch: arch() as 'x64' | 'arm64',
      extensions: {
        dbPath: this.dbPath,
        acpEnabled: this.acpEnabled,
      },
    };
  }

  // ─── healthCheck ────────────────────────────────

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      const db = this.getDb();
      const row = db.prepare('SELECT count(*) as c FROM session').get() as { c: number } | undefined;
      return { ok: true, message: `${row?.c ?? 0} sessions` };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }

  // ─── dispose ────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }

  // ─── Private helpers ────────────────────────────

  private getDb(): Database.Database {
    if (!this.db) {
      try {
        this.db = new Database(this.dbPath, { readonly: true });
      } catch (e) {
        throw new AdapterError(`Cannot open DB: ${this.dbPath}`, this.id, e);
      }
    }
    return this.db;
  }

  private partToEvent(
    partData: PartData,
    part: PartRow,
    msg: MessageRow,
    msgData: MessageData,
    sessionId: string,
  ): SessionEvent | null {
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
        const text = (partData as PartDataText).text ?? '';
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
        const toolData = partData as PartDataTool;
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
        const text = (partData as PartDataReasoning).text ?? '';
        if (!text) return null;
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

function mapRoleToEventType(role: string): string {
  switch (role) {
    case 'user': return 'user_message';
    case 'assistant': return 'assistant_message';
    case 'system': return 'system';
    default: return role;
  }
}
