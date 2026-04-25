/**
 * ⚠️ 待实测：本 adapter 的路径假设和 jsonl schema 在 v1.1 阶段未实测。
 * 已知风险：
 * - ~/.claude/projects 路径可能因平台/版本不同而异（已加 fallback）
 * - jsonl 字段名假设：role/content/timestamp，实际可能不同
 * - 首次部署后必须用 detectClaudeCodeWithDryRun() 验证
 *
 * 待 P0 验收前：用户首次启用此 adapter 需手动确认。
 *
 * ClaudeCodeAdapter — collects session events from ClaudeCode project sessions.
 * Ref: self-learning-loop-skill-design-v1.1.md §4.2.2
 * @module
 */
import { existsSync } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { homedir, platform, arch } from 'node:os';
import { join, basename } from 'node:path';

import type {
  EnvFingerprint,
  SessionEvent,
  SessionRef,
} from '../kernel/schemas/session.js';
import { AdapterError, type AuditSink, type RuntimeAdapter } from './base.js';

// ─── Constants ──────────────────────────────────────

/** Candidate paths for ClaudeCode projects directory, ordered by likelihood. */
const CANDIDATE_PATHS = [
  join(homedir(), '.claude', 'projects'),
  join(homedir(), '.config', 'claude', 'projects'),
  join(homedir(), 'Library', 'Application Support', 'Claude', 'projects'),
];

// ─── Config ─────────────────────────────────────────

export interface ClaudeCodeAdapterOptions {
  /** Override the projects root directory. If omitted, auto-detected via fallback chain. */
  projectsRoot?: string;
  /** Optional audit sink for non-fatal warnings. */
  auditSink?: AuditSink;
}

// ─── Dry-run detection ──────────────────────────────

export interface DryRunResult {
  success: boolean;
  detectedPath?: string;
  triedPaths: string[];
  hint: string;
}

/**
 * Probe the filesystem for ClaudeCode project directories with detailed diagnostics.
 * Use when detect() returns false to guide the user.
 */
export async function detectClaudeCodeWithDryRun(
  overridePaths?: string[],
): Promise<DryRunResult> {
  const candidates = overridePaths ?? CANDIDATE_PATHS;
  const triedPaths: string[] = [];

  for (const candidate of candidates) {
    triedPaths.push(candidate);
    if (!existsSync(candidate)) continue;

    // Path exists — check if it has any subdirectories (projects)
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      const hasProjects = entries.some((e) => e.isDirectory());
      if (hasProjects) {
        return {
          success: true,
          detectedPath: candidate,
          triedPaths,
          hint: `检测到 ClaudeCode 项目目录：${candidate}`,
        };
      }
      // Directory exists but empty
      return {
        success: false,
        detectedPath: candidate,
        triedPaths,
        hint: '请先用 ClaudeCode 完成至少一个 session',
      };
    } catch {
      continue;
    }
  }

  // None of the candidate paths exist
  const claudeBase = join(homedir(), '.claude');
  if (!existsSync(claudeBase)) {
    return {
      success: false,
      triedPaths,
      hint: '请确认 ClaudeCode 已安装并至少运行过一次',
    };
  }

  return {
    success: false,
    triedPaths,
    hint: '请通过配置文件 adapters.claude-code.projects_root 自定义路径',
  };
}

// ─── Adapter ────────────────────────────────────────

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly version = '0.1.0';

  private projectsRoot: string | null = null;
  private readonly auditSink?: AuditSink;

  constructor(options?: ClaudeCodeAdapterOptions) {
    if (options?.projectsRoot) {
      this.projectsRoot = options.projectsRoot;
    }
    this.auditSink = options?.auditSink;
  }

  // §4.2.2 — multi-path fallback detection
  async detect(): Promise<boolean> {
    if (this.projectsRoot && existsSync(this.projectsRoot)) return true;

    for (const candidate of CANDIDATE_PATHS) {
      if (existsSync(candidate)) {
        this.projectsRoot = candidate;
        return true;
      }
    }
    return false;
  }

  // ⚠️ 待实测：实际 schema 可能与 v1 假设不同，首次失败会触发 dry-run 引导
  async listNewSessions(since: Date): Promise<SessionRef[]> {
    if (!this.projectsRoot) {
      throw new AdapterError('projectsRoot not set — call detect() first', this.id);
    }

    const refs: SessionRef[] = [];

    try {
      const projects = await readdir(this.projectsRoot, { withFileTypes: true });

      for (const project of projects) {
        if (!project.isDirectory()) continue;

        const sessionsDir = join(this.projectsRoot, project.name, 'sessions');
        if (!existsSync(sessionsDir)) continue;

        const files = await readdir(sessionsDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;

          const fullPath = join(sessionsDir, file);
          const fileStat = await stat(fullPath);

          if (fileStat.mtime >= since) {
            refs.push({
              path: fullPath,
              runtime: this.id,
              sessionId: basename(file, '.jsonl'),
              startedAt: fileStat.birthtime,
              byteSize: fileStat.size,
            });
          }
        }
      }
    } catch (err) {
      throw new AdapterError(
        `Failed to list sessions: ${String(err)}`,
        this.id,
        err,
      );
    }

    return refs;
  }

  /**
   * ⚠️ 待实测：jsonl 字段名假设 role/content/timestamp，实际可能不同。
   * Parses ClaudeCode session jsonl into normalized SessionEvent stream.
   */
  async *extractEvents(ref: SessionRef): AsyncIterable<SessionEvent> {
    let raw: string;
    try {
      raw = await readFile(ref.path, 'utf-8');
    } catch (err) {
      throw new AdapterError(
        `Failed to read session file: ${ref.path}`,
        this.id,
        err,
      );
    }

    const lines = raw.split('\n').filter((l) => l.trim());
    let lineNum = 0;

    for (const line of lines) {
      lineNum++;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.auditSink?.({
          event_id: `${ref.sessionId}-L${lineNum}`,
          type: 'adapter_warning',
          timestamp: new Date().toISOString(),
          actor: this.id,
          data: { message: `Malformed JSON at line ${lineNum}`, line: line.slice(0, 200) },
        });
        continue;
      }

      // Map ClaudeCode fields → normalized SessionEvent
      // ⚠️ 假设字段：role, content, timestamp — 待实测验证
      const role = String(parsed['role'] ?? 'unknown');
      const typeMap: Record<string, string> = {
        user: 'user_message',
        human: 'user_message',
        assistant: 'assistant_message',
        system: 'system',
        tool_use: 'tool_call',
        tool_result: 'tool_result',
      };
      const type = typeMap[role] ?? role;

      const content =
        typeof parsed['content'] === 'string'
          ? parsed['content']
          : JSON.stringify(parsed['content'] ?? '');

      const timestamp = parsed['timestamp']
        ? new Date(String(parsed['timestamp']))
        : new Date();

      yield {
        type,
        timestamp,
        content,
        metadata: { source: 'claude-code', originalRole: role },
      };
    }
  }

  async getEnvFingerprint(): Promise<EnvFingerprint> {
    return {
      runtime: 'claude-code',
      runtimeVersion: this.version,
      platform: platform() as 'linux' | 'darwin' | 'win32',
      arch: arch() as 'x64' | 'arm64',
    };
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    const detected = await this.detect();
    if (detected) {
      return { ok: true, message: `Projects root: ${this.projectsRoot}` };
    }
    return {
      ok: false,
      message: '请运行 openclaw-learn detect-claude --dry-run 排查',
    };
  }

  async dispose(): Promise<void> {
    this.projectsRoot = null;
  }
}
