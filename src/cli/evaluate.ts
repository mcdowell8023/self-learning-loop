// src/cli/evaluate.ts
//
// T-055 · `openclaw-learn evaluate` / `evaluate-all`
//
// 触发 ReviewGate 对候选执行四维审查，把候选从 pending 推动到 validating /
// rejected。dry-run 模式只跑 review() 看结果，不驱动状态机；execute 模式让
// ReviewGate 内部 transition + 主动重写 mirror（携带 transitions + reviewResult
// 上下文，落 frontmatter 三字段：last_evaluated_at / evaluation_result /
// verdict_history）。
//
// 不调 evaluateCandidate（plan §Q1：当前阶段只走 ReviewGate；evaluateCandidate
// 需要 trial 数据，待 T-054 opencode 集成后再接）。

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { openCandidateStore, type CandidateStore } from '../store/candidate-store.js';
import {
  writeMirror,
  type StateTransitionRecord,
  type MirrorContext,
} from '../store/candidate-mirror.js';
import { ReviewGate, type AuditLogSink } from '../review/review-gate.js';
import type { AuditLogEntry, ReviewResult } from '../review/types.js';
import type { Candidate } from '../kernel/types.js';
import { loadConfig } from '../config/loader.js';
import { resolveWorkspace } from './workspace-resolver.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvaluateRunOptions {
  argv: string[];
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Inject store for tests; when provided, ownership stays with the caller. */
  store?: CandidateStore;
  /** Inject candidatesDir for tests (skips loadConfig). */
  candidatesDir?: string;
}

export interface EvaluateRunResult {
  exitCode: number;
  message?: string;
  /** Per-candidate outcome (preview in dry-run; actual final state in execute). */
  rows?: EvaluateRow[];
  summary?: EvaluateSummary;
}

export interface EvaluateRow {
  candidate_id: string;
  title: string;
  current_state: string;
  next_state: 'validating' | 'rejected';
  reason: string;
  duration_ms: number;
}

export interface EvaluateSummary {
  total: number;
  by_final_state: Record<string, number>;
  avg_duration_ms: number;
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
// Usage strings
// ---------------------------------------------------------------------------

const USAGE_SINGLE = [
  'Usage: openclaw-learn evaluate <candidate_id> [options]',
  '',
  'Run the four-dimension ReviewGate on a single candidate.',
  '',
  'Options:',
  '  --dry-run           Preview the outcome without driving state machine (default).',
  '  --execute           Actually run the review (drives transitions + writes mirror).',
  '  --format <fmt>      Output format: table | json (default: table).',
  '  -h, --help          Show this help.',
  '',
].join('\n');

const USAGE_ALL = [
  'Usage: openclaw-learn evaluate-all [options]',
  '',
  'Run the ReviewGate on every candidate currently in `pending`.',
  '',
  'Options:',
  '  --dry-run           Preview outcomes without driving state machine (default).',
  '  --execute           Actually run reviews (drives transitions + writes mirrors).',
  '  --limit <N>         Only process the first N pending candidates.',
  '  --format <fmt>      Output format: table | json (default: table).',
  '  -h, --help          Show this help.',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedFlags {
  dryRun: boolean;
  execute: boolean;
  limit?: number;
  format: 'table' | 'json';
  help: boolean;
  positional: string[];
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    dryRun: true, // default
    execute: false,
    format: 'table',
    help: false,
    positional: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '-h' || tok === '--help' || tok === 'help') {
      flags.help = true;
    } else if (tok === '--dry-run') {
      flags.dryRun = true;
      flags.execute = false;
    } else if (tok === '--execute') {
      flags.execute = true;
      flags.dryRun = false;
    } else if (tok === '--limit' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) flags.limit = Math.floor(n);
    } else if (tok.startsWith('--limit=')) {
      const n = Number(tok.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) flags.limit = Math.floor(n);
    } else if (tok === '--format' && argv[i + 1]) {
      const v = argv[++i]!;
      if (v === 'table' || v === 'json') flags.format = v;
    } else if (tok.startsWith('--format=')) {
      const v = tok.slice('--format='.length);
      if (v === 'table' || v === 'json') flags.format = v;
    } else if (!tok.startsWith('-')) {
      flags.positional.push(tok);
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runEvaluate(opts: EvaluateRunOptions): Promise<EvaluateRunResult> {
  return runEvaluateInternal(opts, /* mode */ 'single');
}

export async function runEvaluateAll(opts: EvaluateRunOptions): Promise<EvaluateRunResult> {
  return runEvaluateInternal(opts, /* mode */ 'all');
}

async function runEvaluateInternal(
  opts: EvaluateRunOptions,
  mode: 'single' | 'all',
): Promise<EvaluateRunResult> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));
  const cwd = opts.cwd ?? process.cwd();

  const flags = parseFlags(opts.argv);

  if (flags.help) {
    out(mode === 'single' ? USAGE_SINGLE : USAGE_ALL);
    return { exitCode: 0 };
  }

  // Resolve store + candidates dir
  const { workspace } = resolveWorkspace({ cwd, env: process.env });

  let candidatesDir: string;
  let dbPath: string;
  if (opts.store && opts.candidatesDir) {
    candidatesDir = opts.candidatesDir;
    dbPath = ''; // unused
  } else {
    let config: ReturnType<typeof loadConfig> | null = null;
    try {
      config = loadConfig({ projectConfigPath: join(workspace, 'learn', 'config.yaml') });
    } catch {
      config = null;
    }
    const baseDir =
      config?.storage?.base_dir?.replace('$WORKSPACE', workspace) ??
      join(workspace, 'learn');
    dbPath = join(baseDir, 'candidates.db');
    candidatesDir =
      config?.storage?.candidates_dir?.replace('$WORKSPACE', workspace) ??
      join(baseDir, 'candidates');
  }

  const ownsStore = !opts.store;
  let store: CandidateStore;
  if (opts.store) {
    store = opts.store;
  } else {
    if (!existsSync(dbPath)) {
      err(`error: candidate store not found at ${dbPath}. Run 'openclaw-learn init' first.\n`);
      return { exitCode: 2, message: 'store not found' };
    }
    store = openCandidateStore({ dbPath, defaultActor: 'system', candidatesDir });
  }

  try {
    // Build candidate list
    let candidates: Candidate[] = [];
    if (mode === 'single') {
      const id = flags.positional[0];
      if (!id) {
        err('error: evaluate requires <candidate_id>\n' + USAGE_SINGLE);
        return { exitCode: 2, message: 'missing candidate_id' };
      }
      const c = store.get(id);
      if (!c) {
        err(`error: candidate not found: ${id}\n`);
        return { exitCode: 3, message: 'not found' };
      }
      candidates = [c];
    } else {
      candidates = store.list({ state: 'pending' });
      if (flags.limit && candidates.length > flags.limit) {
        candidates = candidates.slice(0, flags.limit);
      }
    }

    if (candidates.length === 0) {
      const msg = mode === 'single' ? 'no candidate to evaluate' : 'no pending candidates';
      out(`${msg}\n`);
      return {
        exitCode: 0,
        rows: [],
        summary: { total: 0, by_final_state: {}, avg_duration_ms: 0, dry_run: flags.dryRun },
      };
    }

    // Execute
    const auditEntries: AuditLogEntry[] = [];
    const auditSink: AuditLogSink = { append: (e) => { auditEntries.push(e); } };

    const rows: EvaluateRow[] = [];
    const stateCounts: Record<string, number> = {};

    for (const c of candidates) {
      const targetCandidate =
        c.state === 'pending' || c.state === 'reviewing'
          ? c
          : null;

      let row: EvaluateRow;
      if (!targetCandidate) {
        // Skip candidates not in a reviewable state
        row = {
          candidate_id: c.candidate_id,
          title: c.strategy.problem_category,
          current_state: c.state,
          next_state: 'rejected', // placeholder; we'll mark in reason
          reason: `skipped: state '${c.state}' not reviewable`,
          duration_ms: 0,
        };
        rows.push(row);
        continue;
      }

      const t0 = Date.now();
      let result: ReviewResult;

      if (flags.dryRun) {
        // Dry-run: build a one-shot in-memory store wrapper that records but
        // does NOT persist transitions, so ReviewGate's mandatory transitions
        // don't mutate real state.
        const dryStore = makeDryRunStore(c);
        const gate = new ReviewGate(dryStore, {
          strategyLookup: ReviewGate.lookupFromStore(store),
          reviewer: 'cli/evaluate(dry-run)',
          auditSink,
          // llm undefined → conflict dimension degrades to pass+warning
        });
        try {
          result = await gate.review(c);
        } catch (e) {
          row = {
            candidate_id: c.candidate_id,
            title: c.strategy.problem_category,
            current_state: c.state,
            next_state: 'rejected',
            reason: `error: ${e instanceof Error ? e.message : String(e)}`,
            duration_ms: Date.now() - t0,
          };
          rows.push(row);
          continue;
        }
      } else {
        const gate = new ReviewGate(store, {
          strategyLookup: ReviewGate.lookupFromStore(store),
          reviewer: 'cli/evaluate',
          auditSink,
        });
        try {
          result = await gate.review(c);
        } catch (e) {
          row = {
            candidate_id: c.candidate_id,
            title: c.strategy.problem_category,
            current_state: c.state,
            next_state: 'rejected',
            reason: `error: ${e instanceof Error ? e.message : String(e)}`,
            duration_ms: Date.now() - t0,
          };
          rows.push(row);
          continue;
        }

        // Execute mode: rewrite mirror with full ctx so frontmatter gains
        // last_evaluated_at / evaluation_result / verdict_history.
        const finalCandidate = store.get(c.candidate_id);
        if (finalCandidate) {
          const transitions: StateTransitionRecord[] = store.getTransitions(c.candidate_id);
          const ctx: MirrorContext = {
            transitions,
            latestReviewResult: result,
          };
          try {
            writeMirror(candidatesDir, finalCandidate, ctx);
          } catch (e) {
            err(
              `warn: mirror write failed for ${c.candidate_id}: ${
                e instanceof Error ? e.message : String(e)
              }\n`,
            );
          }
        }
      }

      const duration = Date.now() - t0;
      row = {
        candidate_id: c.candidate_id,
        title: c.strategy.problem_category,
        current_state: c.state,
        next_state: result.final_state,
        reason: buildReason(result),
        duration_ms: duration,
      };
      rows.push(row);
      stateCounts[result.final_state] = (stateCounts[result.final_state] ?? 0) + 1;
    }

    const totalDuration = rows.reduce((acc, r) => acc + r.duration_ms, 0);
    const avg = rows.length > 0 ? Math.round(totalDuration / rows.length) : 0;

    const summary: EvaluateSummary = {
      total: rows.length,
      by_final_state: stateCounts,
      avg_duration_ms: avg,
      dry_run: flags.dryRun,
    };

    if (flags.format === 'json') {
      out(JSON.stringify({ rows, summary }, null, 2) + '\n');
    } else {
      renderTable(rows, summary, out);
    }

    return { exitCode: 0, rows, summary };
  } finally {
    if (ownsStore) {
      try { store.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReason(r: ReviewResult): string {
  if (r.pass) return 'all dimensions passed';
  const failed = r.dimensions.find((d) => !d.pass);
  if (!failed) return `failed at ${r.failed_at ?? 'unknown'}`;
  const code = failed.code ? `[${failed.code}] ` : '';
  const reason = failed.reason ?? 'no detail';
  return `${failed.dimension}: ${code}${reason}`;
}

/** Truncate a Chinese-ish title to roughly N visual columns (treat each
 *  non-ASCII char as 2 cols, like CJK). */
function truncateTitle(title: string, maxCols: number): string {
  let cols = 0;
  let out = '';
  for (const ch of title) {
    const w = ch.charCodeAt(0) > 127 ? 2 : 1;
    if (cols + w > maxCols) {
      out += '…';
      break;
    }
    cols += w;
    out += ch;
  }
  return out;
}

function padCols(s: string, width: number): string {
  let cols = 0;
  for (const ch of s) cols += ch.charCodeAt(0) > 127 ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - cols));
}

function renderTable(
  rows: EvaluateRow[],
  summary: EvaluateSummary,
  out: (s: string) => void,
): void {
  if (rows.length === 0) {
    out('(no rows)\n');
    return;
  }

  const headers = ['候选 ID', '标题', '当前状态', '→ 目标状态', '主因'];
  const widths = [10, 32, 10, 13, 60];

  const fmt = (cells: string[]) =>
    cells.map((c, i) => padCols(c, widths[i]!)).join('  ');

  out(fmt(headers) + '\n');
  out('-'.repeat(widths.reduce((a, b) => a + b + 2, 0)) + '\n');

  for (const r of rows) {
    out(
      fmt([
        r.candidate_id.slice(0, 8),
        truncateTitle(r.title, widths[1]! - 1),
        r.current_state,
        r.next_state,
        truncateTitle(r.reason, widths[4]! - 1),
      ]) + '\n',
    );
  }

  out('\n── ' + (summary.dry_run ? 'dry-run summary' : 'execute summary') + ' ');
  out('─'.repeat(40) + '\n');
  out(`总候选数:        ${summary.total}\n`);
  for (const [state, count] of Object.entries(summary.by_final_state)) {
    out(`→ ${state}: ${count}\n`);
  }
  out(`平均处理时长:    ${summary.avg_duration_ms} ms / 条\n`);
  out('─'.repeat(44) + '\n');
}

/**
 * Build a TransitionCapableStore that satisfies ReviewGate's interface but
 * only tracks transitions in memory — used in dry-run so we never mutate the
 * real SQLite state. `get()` returns the candidate with the in-memory state
 * so ReviewGate's "expected pending or reviewing" guard passes.
 */
function makeDryRunStore(initial: Candidate): {
  transition: (...args: any[]) => Candidate;
  get: (id: string) => Candidate | null;
} {
  let current: Candidate = initial;
  return {
    transition: (
      _id: string,
      _from: any,
      to: any,
      _action: string,
      _opts?: any,
    ): Candidate => {
      current = { ...current, state: to };
      return current;
    },
    get: (id: string) => (id === current.candidate_id ? current : null),
  };
}
