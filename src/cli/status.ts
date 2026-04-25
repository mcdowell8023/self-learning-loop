// src/cli/status.ts
//
// T-P1a-011 · `openclaw-learn status [id]` — 候选列表/详情。
//
// 无参数：
//   - 列出全部 candidate，按 state 分组（pending / reviewing / shadow_testing /
//     validating / validated / graduated / retired / rejected），每组内部按
//     created_at 升序。
//   - 每行：id(缩写 8 字符) | scope | name | state | trial_count | confidence | created_at
//   - 过滤：`--scope <s>`、`--state <s>`；多值用逗号隔开。
//
// 带 <id>（支持前缀匹配）：
//   - 展示单候选详情：完整 id、strategy 字段、state、trial 历史、L1/L2 评估、
//     shadow summary（若在 instances.trial_results 中存在）。
//   - id 不存在 → exit 3；前缀歧义 → exit 4。
//
// 不依赖 chalk（保持 zero-dep 新增），手写列宽对齐。

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  CandidateStore,
  openCandidateStore,
} from '../store/candidate-store.js';
import type { Candidate, CandidateState, CandidateScope, TrialResult } from '../kernel/types.js';

// Ordering used for grouped list output.
const STATE_ORDER: CandidateState[] = [
  'pending',
  'reviewing',
  'validating',
  'conflict',
  'dormant',
  'graduated',
  'retired',
  'rejected',
];

export interface StatusRunOptions {
  argv: string[];
  cwd?: string;
  store?: CandidateStore;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export interface StatusResult {
  exitCode: number;
  matched?: number;
  candidateId?: string;
  message?: string;
}

const USAGE = [
  'Usage:',
  '  openclaw-learn status                       List all candidates, grouped by state.',
  '  openclaw-learn status <id|id-prefix>        Show single candidate details.',
  '',
  'Filters (list mode only):',
  '  --scope <s[,s...]>   Filter by scope (general, problem-specific, ...).',
  '  --state <s[,s...]>   Filter by state (pending, reviewing, ...).',
  '',
  'Common:',
  '  --db <path>          Candidate Store path (default: <workspace>/learn/candidates.db).',
  '  --workspace <path>   Workspace dir (default: $PWD).',
  '  -h, --help           Show help.',
  '',
].join('\n');

interface Parsed {
  kind: 'ok' | 'help' | 'error';
  candidateId?: string;
  scopeFilter?: string[];
  stateFilter?: string[];
  dbFlag?: string;
  workspaceFlag?: string;
  code?: number;
  message?: string;
}

export function parseStatusArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  let scopeFilter: string[] | undefined;
  let stateFilter: string[] | undefined;
  let dbFlag: string | undefined;
  let workspaceFlag: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { kind: 'help' };
    else if (a === '--scope') {
      const v = argv[++i];
      if (!v) return { kind: 'error', code: 2, message: 'error: --scope requires a value' };
      scopeFilter = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--state') {
      const v = argv[++i];
      if (!v) return { kind: 'error', code: 2, message: 'error: --state requires a value' };
      stateFilter = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--db') {
      const v = argv[++i];
      if (!v) return { kind: 'error', code: 2, message: 'error: --db requires a value' };
      dbFlag = v;
    } else if (a === '--workspace') {
      const v = argv[++i];
      if (!v) return { kind: 'error', code: 2, message: 'error: --workspace requires a value' };
      workspaceFlag = v;
    } else if (a && a.startsWith('--')) {
      return { kind: 'error', code: 2, message: `error: unknown flag: ${a}` };
    } else if (a) {
      positional.push(a);
    }
  }

  if (positional.length > 1) {
    return { kind: 'error', code: 2, message: 'error: too many positional arguments' };
  }

  return {
    kind: 'ok',
    candidateId: positional[0],
    scopeFilter,
    stateFilter,
    dbFlag,
    workspaceFlag,
  };
}

function resolvePath(p: string, cwd: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id.padEnd(8);
}

function countTrials(c: Candidate): number {
  let n = 0;
  for (const inst of c.instances) n += inst.trial_results?.length ?? 0;
  return n;
}

function aggregateConfidence(c: Candidate): number | null {
  // Average all numeric confidences across trials. Returns null if none.
  const vals: number[] = [];
  for (const inst of c.instances) {
    for (const tr of inst.trial_results ?? []) {
      const v = (tr as TrialResult & { confidence?: number }).confidence;
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
    }
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

function formatRow(c: Candidate): string {
  const conf = aggregateConfidence(c);
  return [
    pad(shortId(c.candidate_id), 10),
    pad(c.strategy.scope, 18),
    pad(c.strategy.problem_category, 28),
    pad(c.state, 16),
    pad(String(countTrials(c)), 6),
    pad(conf === null ? '-' : conf.toFixed(2), 6),
    c.created_at,
  ].join(' ');
}

function renderList(
  candidates: Candidate[],
  out: (s: string) => void,
): void {
  if (candidates.length === 0) {
    out('(no candidates)\n');
    return;
  }
  const groups = new Map<CandidateState, Candidate[]>();
  for (const c of candidates) {
    const arr = groups.get(c.state) ?? [];
    arr.push(c);
    groups.set(c.state, arr);
  }

  out(
    pad('ID', 10) +
      ' ' +
      pad('SCOPE', 18) +
      ' ' +
      pad('NAME', 28) +
      ' ' +
      pad('STATE', 16) +
      ' ' +
      pad('TRIAL', 6) +
      ' ' +
      pad('CONF', 6) +
      ' CREATED_AT\n',
  );
  out('─'.repeat(110) + '\n');

  let total = 0;
  for (const state of STATE_ORDER) {
    const list = groups.get(state);
    if (!list || list.length === 0) continue;
    out(`\n[${state}] (${list.length})\n`);
    for (const c of list) {
      out('  ' + formatRow(c) + '\n');
      total++;
    }
  }
  // Any states not in STATE_ORDER (defensive, shouldn't happen).
  for (const [state, list] of groups) {
    if (STATE_ORDER.includes(state)) continue;
    out(`\n[${state}] (${list.length})\n`);
    for (const c of list) {
      out('  ' + formatRow(c) + '\n');
      total++;
    }
  }
  out(`\nTotal: ${total}\n`);
}

function renderDetail(c: Candidate, out: (s: string) => void): void {
  out(`Candidate ${c.candidate_id}\n`);
  out('─'.repeat(60) + '\n');
  out(`  state            : ${c.state}\n`);
  if (c.dormant_reason) out(`  dormant_reason   : ${c.dormant_reason}\n`);
  out(`  scope            : ${c.strategy.scope}\n`);
  out(`  problem_category : ${c.strategy.problem_category}\n`);
  out(`  trigger          : ${c.strategy.trigger_conditions}\n`);
  out(`  action           : ${c.strategy.recommended_action}\n`);
  if (c.strategy.tags && c.strategy.tags.length > 0) {
    out(`  tags             : ${c.strategy.tags.join(', ')}\n`);
  }
  out(`  created_at       : ${c.created_at}\n`);
  out(`  updated_at       : ${c.updated_at}\n`);
  out(`  instances        : ${c.instances.length}\n`);

  // Trial history across instances.
  let trialIdx = 0;
  for (const inst of c.instances) {
    const trials = inst.trial_results ?? [];
    if (trials.length === 0) continue;
    out(`\n  instance ${inst.instance_id} — ${trials.length} trial(s)\n`);
    for (const tr of trials) {
      trialIdx++;
      const t = tr as TrialResult & {
        confidence?: number;
        l1_pass?: boolean;
        l2_pass?: boolean;
        shadow_summary?: unknown;
      };
      out(
        `    [${trialIdx}] ts=${(t as unknown as { ts?: string }).ts ?? '-'} ` +
          `l1=${fmtBool(t.l1_pass)} l2=${fmtBool(t.l2_pass)} ` +
          `conf=${typeof t.confidence === 'number' ? t.confidence.toFixed(2) : '-'}\n`,
      );
      if (t.shadow_summary) {
        out(`         shadow: ${stringifyOneLine(t.shadow_summary)}\n`);
      }
    }
  }
  if (trialIdx === 0) {
    out('\n  (no trial history)\n');
  }
}

function fmtBool(v: unknown): string {
  if (v === true) return 'pass';
  if (v === false) return 'fail';
  return '-';
}

function stringifyOneLine(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 197) + '...' : s;
  } catch {
    return String(v);
  }
}

export async function runStatus(opts: StatusRunOptions): Promise<StatusResult> {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  const cwd = opts.cwd ?? process.cwd();

  const parsed = parseStatusArgs(opts.argv);
  if (parsed.kind === 'error') {
    err((parsed.message ?? 'argument error') + '\n' + USAGE);
    return { exitCode: parsed.code ?? 2, message: parsed.message };
  }
  if (parsed.kind === 'help') {
    out(USAGE);
    return { exitCode: 0 };
  }

  const workspace = parsed.workspaceFlag ? resolvePath(parsed.workspaceFlag, cwd) : cwd;
  const dbPath = parsed.dbFlag
    ? resolvePath(parsed.dbFlag, cwd)
    : join(workspace, 'learn', 'candidates.db');

  if (!opts.store && !existsSync(dbPath)) {
    const msg = `error: candidate store not found at ${dbPath} (run \`openclaw-learn init\` first)`;
    err(msg + '\n');
    return { exitCode: 2, message: msg };
  }

  const store = opts.store ?? openCandidateStore({ dbPath });
  const ownsStore = !opts.store;

  try {
    if (parsed.candidateId) {
      // Detail mode — support prefix matching.
      const idOrPrefix = parsed.candidateId;
      const direct = store.get(idOrPrefix);
      let candidate = direct;
      if (!candidate) {
        // Prefix search across all candidates (P1a scale: small).
        const all = store.list({ limit: 100000 });
        const matches = all.filter((c) => c.candidate_id.startsWith(idOrPrefix));
        if (matches.length === 0) {
          const msg = `error: no candidate matches id/prefix '${idOrPrefix}'`;
          err(msg + '\n');
          return { exitCode: 3, message: msg };
        }
        if (matches.length > 1) {
          err(
            `error: id prefix '${idOrPrefix}' is ambiguous (${matches.length} matches):\n` +
              matches.map((m) => '  ' + m.candidate_id).join('\n') +
              '\n',
          );
          return { exitCode: 4, message: 'ambiguous id prefix' };
        }
        candidate = matches[0]!;
      }
      renderDetail(candidate, out);
      return { exitCode: 0, matched: 1, candidateId: candidate.candidate_id };
    }

    // List mode.
    let all = store.list({ limit: 100000 });
    if (parsed.scopeFilter) {
      const set = new Set(parsed.scopeFilter);
      all = all.filter((c) => set.has(c.strategy.scope as CandidateScope));
    }
    if (parsed.stateFilter) {
      const set = new Set(parsed.stateFilter);
      all = all.filter((c) => set.has(c.state));
    }
    renderList(all, out);
    return { exitCode: 0, matched: all.length };
  } finally {
    if (ownsStore) store.close();
  }
}
