// src/cli/reflect.ts
//
// `openclaw-learn reflect` — CLI wrapper for reflection engine.
//
// 流程: 加载 config → 读反思源 → trigger 判定 → candidate-generator → 写入 Store (除非 --dry-run)

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, appendFileSync } from 'node:fs';
import { isAbsolute, join, resolve, basename } from 'node:path';
import { arch, platform } from 'node:os';
import { createHash } from 'node:crypto';

import { CandidateGenerator, type ReflectInput } from '../reflect/candidate-generator.js';
import type { SessionEvent } from '../reflect/reflection-prompt.js';
import type { EnvFingerprint } from '../kernel/types.js';
import { openCandidateStore } from '../store/candidate-store.js';
import type { LLMClient, LLMCompleteOptions } from '../reflect/llm-client.js';
import { createRealLLMClient, type LLMProviderConfig } from '../reflect/llm-client-real.js';

// ---------------------------------------------------------------------------
// CLI interface
// ---------------------------------------------------------------------------

export interface ReflectRunOptions {
  argv: string[];
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export interface ReflectResult {
  exitCode: number;
  message?: string;
}

const USAGE = [
  'Usage: openclaw-learn reflect [options]',
  '',
  'Run a reflection pass: analyse memory sources, generate candidates.',
  '',
  'Options:',
  '  --workspace <dir>  Workspace directory (default: ~/.openclaw/workspace)',
  '  --dry-run          Print candidates without persisting to DB',
  '  --source <path>    Specific memory file to reflect on (bypasses incremental)',
  '  --from YYYY-MM-DD  Start date (inclusive, overrides watermark)',
  '  --to YYYY-MM-DD    End date (inclusive, default: yesterday)',
  '  --today            Shortcut: reflect on today\'s diary only',
  '  --provider <name>  LLM provider: openclaw | openai-compatible (overrides config)',
  '  --verbose, -v      Show event previews and raw LLM responses',
  '  -h, --help         Show this help',
  '',
].join('\n');

interface ParsedReflect {
  kind: 'ok' | 'help' | 'error';
  workspace?: string;
  dryRun?: boolean;
  source?: string;
  from?: string;
  to?: string;
  today?: boolean;
  verbose?: boolean;
  provider?: 'openclaw' | 'openai-compatible';
  code?: number;
  message?: string;
}

function parseReflectArgs(argv: string[]): ParsedReflect {
  let workspace: string | undefined;
  let dryRun = false;
  let source: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let today = false;
  let verbose = false;
  let provider: 'openclaw' | 'openai-compatible' | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { kind: 'help' };
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--today') today = true;
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--provider') {
      const v = argv[++i] as 'openclaw' | 'openai-compatible' | undefined;
      if (v !== 'openclaw' && v !== 'openai-compatible') return { kind: 'error', code: 2, message: 'error: --provider must be openclaw or openai-compatible' };
      provider = v;
    }
    else if (a === '--workspace') {
      const v = argv[++i];
      if (!v) return { kind: 'error', code: 2, message: 'error: --workspace requires a value' };
      workspace = v;
    } else if (a === '--source') {
      const v = argv[++i];
      if (!v) return { kind: 'error', code: 2, message: 'error: --source requires a value' };
      source = v;
    } else if (a === '--from') {
      const v = argv[++i];
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { kind: 'error', code: 2, message: 'error: --from requires YYYY-MM-DD' };
      from = v;
    } else if (a === '--to') {
      const v = argv[++i];
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { kind: 'error', code: 2, message: 'error: --to requires YYYY-MM-DD' };
      to = v;
    } else {
      return { kind: 'error', code: 2, message: `error: unknown argument: ${a}` };
    }
  }
  return { kind: 'ok', workspace, dryRun, source, from, to, today, verbose, provider };
}

// ---------------------------------------------------------------------------
// Source loading: read memory files into SessionEvent[]
// ---------------------------------------------------------------------------

function todayAndYesterday(): string[] {
  const d = new Date();
  const fmt = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const today = fmt(d);
  const y = new Date(d);
  y.setDate(y.getDate() - 1);
  return [fmt(y), today];
}

function fmtDate(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const cur = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (cur <= end) {
    dates.push(fmtDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

/** Load memory files for a specific set of dates */
function loadSourceFilesForDates(workspace: string, dates: string[]): { events: SessionEvent[]; files: string[]; dateFileMap: Map<string, string[]> } {
  const events: SessionEvent[] = [];
  const files: string[] = [];
  const dateFileMap = new Map<string, string[]>();
  const memDir = join(workspace, 'memory');
  if (!existsSync(memDir)) return { events, files, dateFileMap };

  for (const date of dates) {
    // Match YYYY-MM-DD.md and YYYY-MM-DD-*.md (session-memory slugs)
    const allFiles = readdirSync(memDir).filter(f => f.startsWith(date) && f.endsWith('.md'));
    const matched: string[] = [];
    for (const fname of allFiles) {
      const p = join(memDir, fname);
      if (existsSync(p)) {
        files.push(p);
        matched.push(p);
        events.push(...fileToEvents(p));
      }
    }
    if (matched.length > 0) dateFileMap.set(date, matched);
  }
  return { events, files, dateFileMap };
}

function loadSourceFiles(workspace: string, sourcePath?: string): { events: SessionEvent[]; files: string[] } {
  const events: SessionEvent[] = [];
  const files: string[] = [];

  if (sourcePath) {
    const p = isAbsolute(sourcePath) ? sourcePath : resolve(process.cwd(), sourcePath);
    if (existsSync(p)) {
      files.push(p);
      events.push(...fileToEvents(p));
    }
    return { events, files };
  }

  // Default: today + yesterday memory files
  const memDir = join(workspace, 'memory');
  if (!existsSync(memDir)) return { events, files };

  const dates = todayAndYesterday();
  for (const date of dates) {
    const p = join(memDir, `${date}.md`);
    if (existsSync(p)) {
      files.push(p);
      events.push(...fileToEvents(p));
    }
  }
  return { events, files };
}

function extractDateFromFilename(filePath: string): string | null {
  const m = basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] + 'T00:00:00.000Z' : null;
}

function extractTimestampFromSection(section: string, fallback: string): string {
  // Try common timestamp patterns in section content
  const patterns = [
    /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:?\d{2})?)/,
    /(\d{2}:\d{2}(?::\d{2})?)/, // time only
  ];
  for (const p of patterns) {
    const m = section.match(p);
    if (m) {
      const match = m[1]!;
      // If time-only, prepend fallback date
      if (!match.includes('-')) {
        const dateBase = fallback.slice(0, 10);
        return `${dateBase}T${match}:00.000Z`;
      }
      return new Date(match).toISOString();
    }
  }
  return fallback;
}

/**
 * Detect "empty heartbeat" diary sections that pollute reflection input.
 * Patterns: 心跳/巡检 with all four fields empty (无新增/无).
 */
function isEmptyHeartbeat(content: string): boolean {
  const c = content.replace(/\s+/g, ' ');
  // Tagged as heartbeat AND key fields are empty/无
  const isHeartbeatTagged = /#心跳|#巡检|心跳巡检/.test(c);
  if (!isHeartbeatTagged) return false;
  // All three core fields say 无 / 无新增 / 无新增用户交互
  const eventEmpty = /\*\*事件：?\*\*\s*[^*\n]{0,30}(无新增|无新|无$|无 )/.test(c);
  const decisionEmpty = /\*\*决策：?\*\*\s*无/.test(c);
  const impactEmpty = /\*\*影响：?\*\*\s*无/.test(c);
  return eventEmpty && decisionEmpty && impactEmpty;
}

function fileToEvents(filePath: string): SessionEvent[] {
  const content = readFileSync(filePath, 'utf-8');
  if (!content.trim()) return [];

  const fileDate = extractDateFromFilename(filePath)
    ?? new Date(statSync(filePath).mtime).toISOString();

  // Split by ### headings (diary sections) first; fall back to ## if no ### found
  const h3parts = content.split(/^### /m);
  if (h3parts.length > 1) {
    // h3parts[0] is content before first ###, rest are sections
    const events: SessionEvent[] = [];
    const preamble = h3parts[0]!.trim();
    if (preamble.length >= 50) {
      events.push({
        type: 'system' as const,
        timestamp: fileDate,
        content: preamble,
        metadata: { source: basename(filePath) },
      });
    }
    for (let i = 1; i < h3parts.length; i++) {
      const sectionContent = '### ' + h3parts[i]!.trim();
      if (sectionContent.length < 50) continue;
      if (isEmptyHeartbeat(sectionContent)) continue; // skip empty heartbeats
      const ts = extractTimestampFromSection(sectionContent, fileDate);
      events.push({
        type: 'system' as const,
        timestamp: ts,
        content: sectionContent,
        metadata: { source: basename(filePath) },
      });
    }
    if (events.length > 0) return events;
    // fall through if all sections were too short
  }

  // Fallback: split by ## or treat whole file as one event
  const sections = content.split(/^## /m).filter(Boolean);
  return sections.map((section, i) => ({
    type: 'system' as const,
    timestamp: fileDate,
    content: (i > 0 ? '## ' : '') + section.trim(),
    metadata: { source: basename(filePath) },
  }));
}

// ---------------------------------------------------------------------------
// Token budget inline check
// ---------------------------------------------------------------------------

function checkTokenBudget(workspace: string, dailyBudget: number): { ok: boolean; used: number; budget: number } {
  const today = fmtDate(new Date());
  const auditPath = join(workspace, 'learn', 'audit', `reflect-${today}.jsonl`);
  let used = 0;
  if (existsSync(auditPath)) {
    const lines = readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.tokens_used && typeof entry.tokens_used === 'number') {
          used += entry.tokens_used;
        }
      } catch { /* skip malformed */ }
    }
  }
  return { ok: used < dailyBudget, used, budget: dailyBudget };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function writeAuditEvent(workspace: string, event: Record<string, unknown>): void {
  const today = fmtDate(new Date());
  const auditDir = join(workspace, 'learn', 'audit');
  mkdirSync(auditDir, { recursive: true });
  const auditPath = join(auditDir, `reflect-${today}.jsonl`);
  appendFileSync(auditPath, JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + '\n');
}

// ---------------------------------------------------------------------------
// Dry-run no-op store wrapper
// ---------------------------------------------------------------------------

class DryRunStore {
  get(_id: string) { return null; }
  create(_data: unknown) { /* no-op */ }
  getJournalMode() { return 'wal'; }
  getWatermark() { return null; }
  setWatermark() { /* no-op */ }
  hasReflectionLog() { return false; }
  addReflectionLog() { /* no-op */ }
  close() { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runReflect(opts: ReflectRunOptions): Promise<ReflectResult> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const cwd = opts.cwd ?? process.cwd();

  const parsed = parseReflectArgs(opts.argv);
  if (parsed.kind === 'error') {
    err((parsed.message ?? 'argument error') + '\n' + USAGE);
    return { exitCode: parsed.code ?? 2, message: parsed.message };
  }
  if (parsed.kind === 'help') {
    out(USAGE);
    return { exitCode: 0 };
  }

  const workspace = parsed.workspace
    ? (isAbsolute(parsed.workspace) ? parsed.workspace : join(cwd, parsed.workspace))
    : join(process.env.HOME ?? '/tmp', '.openclaw/workspace');

  const learnDir = join(workspace, 'learn');
  const dbPath = join(learnDir, 'candidates.db');

  // Check workspace init
  if (!parsed.dryRun && !existsSync(dbPath)) {
    const msg = `error: learn/ workspace not initialised at ${learnDir} (run 'openclaw-learn init' first)`;
    err(msg + '\n');
    return { exitCode: 3, message: msg };
  }

  // Store (open early for watermark)
  const store = parsed.dryRun
    ? (new DryRunStore() as any)
    : openCandidateStore({ dbPath });

  try {

  // Determine date range
  let events: SessionEvent[] = [];
  let files: string[] = [];
  let processedDates: string[] = [];
  const verbose = parsed.verbose ?? false;

  if (parsed.source) {
    // --source: bypass incremental, load specific file
    const loaded = loadSourceFiles(workspace, parsed.source);
    events = loaded.events;
    files = loaded.files;
  } else {
    // Incremental mode: determine date range
    let fromDate: string;
    let toDate: string;

    if (parsed.today) {
      const today = fmtDate(new Date());
      fromDate = today;
      toDate = today;
    } else if (parsed.from) {
      fromDate = parsed.from;
      toDate = parsed.to ?? fmtDate((() => { const d = new Date(); d.setDate(d.getDate() - 1); return d; })());
    } else {
      // Default incremental: from watermark+1 to yesterday
      const watermark = store.getWatermark();
      const yesterday = fmtDate((() => { const d = new Date(); d.setDate(d.getDate() - 1); return d; })());
      if (watermark) {
        const next = new Date(watermark + 'T00:00:00');
        next.setDate(next.getDate() + 1);
        fromDate = fmtDate(next);
      } else {
        // No watermark: default to yesterday only
        fromDate = yesterday;
      }
      toDate = parsed.to ?? yesterday;
    }

    if (fromDate > toDate) {
      out(`✅ Already up to date (watermark: ${store.getWatermark() ?? 'none'}, next would be ${fromDate}, target: ${toDate})\n`);
      store.close();
      return { exitCode: 0, message: 'up to date' };
    }

    const dates = dateRange(fromDate, toDate);
    out(`📅 Processing dates: ${fromDate} → ${toDate} (${dates.length} day(s))\n`);

    // Filter out already-processed dates (dedup by date+source_hash)
    const loaded = loadSourceFilesForDates(workspace, dates);
    files = loaded.files;

    // Per-date dedup: skip dates whose source content hasn't changed
    for (const date of dates) {
      const dateFiles = loaded.dateFileMap.get(date);
      if (!dateFiles || dateFiles.length === 0) continue;

      const content = dateFiles.map(f => readFileSync(f, 'utf-8')).join('\n');
      const hash = createHash('sha256').update(content).digest('hex');

      if (!parsed.dryRun && store.hasReflectionLog(date, hash)) {
        out(`   ⏭️  ${date} — already processed (same content)\n`);
        continue;
      }

      processedDates.push(date);
      // Add events for this date
      for (const f of dateFiles) {
        events.push(...fileToEvents(f));
      }
    }
  }
  out(`📖 Loaded ${events.length} events from ${files.length} file(s)\n`);
  for (const f of files) out(`   • ${f}\n`);

  if (verbose) {
    out('\n📋 Event previews:\n');
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      const preview = ev.content.slice(0, 100).replace(/\n/g, ' ');
      out(`   [${i + 1}] ${preview}${ev.content.length > 100 ? '…' : ''}\n`);
    }
    out('\n');
  }

  if (events.length === 0) {
    out('⚠️  No events found — nothing to reflect on.\n');
    return { exitCode: 0, message: 'no events' };
  }

  // Build env fingerprint
  const env: EnvFingerprint = {
    runtime: 'node',
    platform: platform() as EnvFingerprint['platform'],
    arch: arch() as EnvFingerprint['arch'],
    nodeVersion: process.version,
  };

  // Token budget check
  const budgetCheck = checkTokenBudget(workspace, 50000); // TODO: read from config when loader is wired
  if (!budgetCheck.ok) {
    const msg = `⚠️  Daily token budget exceeded (${budgetCheck.used}/${budgetCheck.budget}). Skipping reflect.`;
    out(msg + '\n');
    writeAuditEvent(workspace, { event: 'reflect_skipped_budget', used: budgetCheck.used, budget: budgetCheck.budget });
    return { exitCode: 0, message: 'budget exceeded' };
  }

  // LLM client — provider resolution: CLI flag > env detection > config > default (openclaw)
  const providerOverride = parsed.provider;
  let llm: LLMClient;
  try {
    const llmConfig: Partial<LLMProviderConfig> = {};
    if (providerOverride) {
      llmConfig.provider = providerOverride;
    } else if (process.env.POLLINATIONS_API_KEY) {
      // Backward compat: if POLLINATIONS_API_KEY is set, default to openai-compatible
      llmConfig.provider = 'openai-compatible';
      llmConfig.api_key_env = 'POLLINATIONS_API_KEY';
      llmConfig.base_url = 'https://gen.pollinations.ai/v1';
      llmConfig.model = 'openai'; // Pollinations default model
    }
    // For openai-compatible without explicit key, try POLLINATIONS_API_KEY fallback
    if (llmConfig.provider === 'openai-compatible' && !llmConfig.api_key_env) {
      if (process.env.POLLINATIONS_API_KEY) {
        llmConfig.api_key_env = 'POLLINATIONS_API_KEY';
      }
    }
    llm = createRealLLMClient(llmConfig);
  } catch (e) {
    const msg = `error: LLM client init failed: ${(e as Error).message}`;
    err(msg + '\n');
    return { exitCode: 4, message: msg };
  }

  writeAuditEvent(workspace, { event: 'reflect_started', provider: providerOverride ?? 'openclaw', events_count: events.length });

    const generator = new CandidateGenerator(llm, store);

    const input: ReflectInput = {
      events,
      env,
      sessionId: `cli-reflect-${new Date().toISOString()}`,
      manual: true, // CLI invocation = manual trigger
    };

    out('🔍 Running reflection…\n');
    const result = await generator.reflect(input);

    if (!result.triggered) {
      out('ℹ️  Trigger conditions not met — no reflection performed.\n');
      return { exitCode: 0 };
    }

    if (verbose && result.rawResponse) {
      out('\n🤖 Raw LLM response:\n');
      out(result.rawResponse + '\n');
    }

    if (result.error) {
      err(`⚠️  Reflection error: ${result.error}\n`);
      if (!verbose && result.rawResponse) err(`   Raw LLM response (first 500 chars): ${result.rawResponse.slice(0, 500)}\n`);
      // Still show any partial results
    }

    if (verbose) {
      out(`\n🔬 Parsed candidates array (length=${result.candidates.length}):\n`);
      out(JSON.stringify(result.candidates.map(c => ({
        problem_category: c.strategy.problem_category,
        confidence: c.confidence,
        scope: c.strategy.scope,
      })), null, 2) + '\n');
      if (result.dropped.length > 0) {
        out(`\n🔬 Dropped items (length=${result.dropped.length}):\n`);
        out(JSON.stringify(result.dropped, null, 2) + '\n');
      }
    }

    out(`\n📊 Results:\n`);
    out(`   Triggered: ✅ (reasons: ${result.triggerDecision.reasons.join(', ')})\n`);
    out(`   Candidates generated: ${result.candidates.length}\n`);
    out(`   Dropped: ${result.dropped.length}\n`);

    if (!parsed.dryRun) {
      out(`   Persisted to DB: ${result.persistedCount}\n`);
    } else {
      out(`   [dry-run] Would persist: ${result.candidates.length}\n`);
    }

    if (result.candidates.length > 0) {
      out('\n📝 Candidates:\n');
      for (const c of result.candidates) {
        out(`\n   ─── ${c.strategy.problem_category} ───\n`);
        out(`   Scope: ${c.strategy.scope}\n`);
        out(`   Trigger: ${c.strategy.trigger_conditions}\n`);
        out(`   Action: ${c.strategy.recommended_action}\n`);
        out(`   Confidence: ${c.confidence}\n`);
        if (c.rationale) out(`   Rationale: ${c.rationale}\n`);
      }
    }

    if (result.dropped.length > 0) {
      out('\n🗑️  Dropped:\n');
      for (const d of result.dropped) {
        out(`   • ${d.reason}\n`);
      }
    }

    // Update watermark and reflection log for processed dates
    if (!parsed.dryRun && !parsed.source && processedDates.length > 0) {
      for (const date of processedDates) {
        const memDir = join(workspace, 'memory');
        const dateFiles = readdirSync(memDir).filter(f => f.startsWith(date) && f.endsWith('.md')).map(f => join(memDir, f));
        const content = dateFiles.map(f => readFileSync(f, 'utf-8')).join('\n');
        const hash = createHash('sha256').update(content).digest('hex');
        store.addReflectionLog(date, hash, result.persistedCount);
      }
      // Update watermark to the latest processed date
      const latestDate = processedDates[processedDates.length - 1]!;
      const currentWatermark = store.getWatermark();
      if (!currentWatermark || latestDate > currentWatermark) {
        store.setWatermark(latestDate);
        out(`\n📌 Watermark updated: ${currentWatermark ?? 'none'} → ${latestDate}\n`);
      }
    }

    writeAuditEvent(workspace, {
      event: 'reflect_completed',
      candidates: result.candidates.length,
      dropped: result.dropped.length,
      persisted: result.persistedCount,
      error: result.error ?? null,
    });

    return { exitCode: (result.error && result.candidates.length === 0 && result.dropped.length === 0) ? 0 : (result.error ? 1 : 0) };
  } finally {
    if (!parsed.dryRun && store && typeof store.close === 'function') {
      store.close();
    }
  }
}
