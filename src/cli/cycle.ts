// src/cli/cycle.ts
//
// T-058a · `openclaw-learn cycle` — drive one shadow→evaluate→graduate pass.
//
// Wiring: opens CandidateStore + GraduationExecutor + ShadowRunner from the
// resolved workspace, then calls runCycle(). Defaults to dry-run (safe) so
// users can preview decisions before committing them; pass --execute to
// actually transition state and write graduation files.
//
// Out of scope (T-058a only):
//   - L3 LLM Judge (no --judge flag yet; orchestrator accepts a judge cb,
//     CLI can't construct one until LLM-judge tickets land)
//   - Baseline source (BaselineMetricStore not implemented; CLI passes [])

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { openCandidateStore, type CandidateStore } from '../store/candidate-store.js';
import { TrialCollector } from '../shadow/trial-collector.js';
import { ShadowRunner } from '../shadow/shadow-runner.js';
import { GraduationExecutor } from '../graduation/executor.js';
import { runCycle, thresholdsFromConfig, type CycleReport } from '../orchestrator/cycle.js';
import { loadConfig } from '../config/loader.js';
import { resolveWorkspace } from './workspace-resolver.js';

export interface CycleRunOptions {
  argv: string[];
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Inject store for tests. */
  store?: CandidateStore;
  /** Inject candidatesDir for tests. */
  candidatesDir?: string;
}

export interface CycleRunResult {
  exitCode: number;
  message?: string;
  report?: CycleReport;
}

const USAGE = [
  'Usage: openclaw-learn cycle [options]',
  '',
  'Run one full learning-loop cycle:',
  '  1. Enumerate runtime adapters and pull new sessions',
  '  2. Run ShadowRunner.observe() to collect trials',
  '  3. Evaluate every validating candidate that meets min_trials',
  '  4. Apply truth-table verdict + confidence three-tier gating',
  '  5. Graduate / retire / dormant / conflict transitions',
  '',
  'Options:',
  '  --dry-run                Preview only; no state changes (default).',
  '  --execute                Actually transition states + write graduation files.',
  '  --runtime <id> [...]     Limit to specific runtime adapters (default: openclaw).',
  '  --since <ISO-date>       Only consider sessions newer than this (default: epoch).',
  '  --format <fmt>           Output: table (default) | json',
  '  --workspace <path>       Override workspace dir.',
  '  -h, --help               Show this help.',
  '',
].join('\n');

interface ParsedFlags {
  help: boolean;
  execute: boolean;
  runtimes?: string[];
  since?: Date;
  format: 'table' | 'json';
  workspace?: string;
}

function parseFlags(argv: string[]): ParsedFlags | { error: string } {
  const out: ParsedFlags = { help: false, execute: false, format: 'table' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      out.help = true;
      continue;
    }
    if (a === '--dry-run') continue; // default; explicit form for symmetry
    if (a === '--execute') {
      out.execute = true;
      continue;
    }
    if (a === '--runtime') {
      const v = argv[++i];
      if (!v) return { error: '--runtime requires a value' };
      out.runtimes = (out.runtimes ?? []).concat(v);
      continue;
    }
    if (a === '--since') {
      const v = argv[++i];
      if (!v) return { error: '--since requires an ISO date' };
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return { error: `invalid --since value: ${v}` };
      out.since = d;
      continue;
    }
    if (a === '--format') {
      const v = argv[++i];
      if (v !== 'table' && v !== 'json') {
        return { error: `--format must be 'table' or 'json' (got ${v})` };
      }
      out.format = v;
      continue;
    }
    if (a === '--workspace') {
      const v = argv[++i];
      if (!v) return { error: '--workspace requires a path' };
      out.workspace = v;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  return out;
}

function renderTable(report: CycleReport): string {
  const lines: string[] = [];
  lines.push(`cycle ${report.dryRun ? '[DRY-RUN]' : '[EXECUTE]'} ${report.startedAt} → ${report.finishedAt}`);
  lines.push('');

  lines.push(`Sessions observed: ${report.sessions.length}`);
  for (const s of report.sessions) {
    lines.push(
      `  - [${s.runtime}] ${s.sessionId}: ${s.matchedCount}/${s.candidatesChecked} matched, ${s.trialsWritten} trials`,
    );
  }
  lines.push('');

  lines.push(`Candidates evaluated: ${report.candidates.length}`);
  for (const c of report.candidates) {
    const o = c.outcome;
    let detail = o.status;
    if (o.status === 'graduated' || o.status === 'retired' ||
        o.status === 'dormant' || o.status === 'conflict' ||
        o.status === 'awaiting_more_trials' || o.status === 'needs_human_review') {
      detail += ` verdict=${o.verdict} conf=${o.confidence.toFixed(3)}`;
    } else if (o.status === 'observed_only') {
      detail += ` trials=${o.trial_count}`;
    } else if (o.status === 'error') {
      detail += ` error=${o.error}`;
    }
    lines.push(`  - ${c.candidate_id.slice(0, 18)}…: ${detail}`);
  }

  if (report.errors.length > 0) {
    lines.push('');
    lines.push(`Errors:`);
    for (const e of report.errors) {
      lines.push(`  - [${e.runtime}] ${e.error}`);
    }
  }

  return lines.join('\n') + '\n';
}

export async function runCycleCommand(opts: CycleRunOptions): Promise<CycleRunResult> {
  const out = opts.stdout ?? ((s) => process.stdout.write(s));
  const err = opts.stderr ?? ((s) => process.stderr.write(s));
  const cwd = opts.cwd ?? process.cwd();

  const parsed = parseFlags(opts.argv);
  if ('error' in parsed) {
    err(`error: ${parsed.error}\n${USAGE}`);
    return { exitCode: 2, message: parsed.error };
  }
  const flags = parsed;

  if (flags.help) {
    out(USAGE);
    return { exitCode: 0 };
  }

  const { workspace } = resolveWorkspace({
    cwd,
    env: process.env,
    workspaceFlag: flags.workspace,
  });

  // Resolve paths via config (or fall back to defaults)
  let candidatesDir: string;
  let dbPath: string;
  let baseDir: string;
  let cfg;
  if (opts.store && opts.candidatesDir) {
    candidatesDir = opts.candidatesDir;
    dbPath = ''; // unused
    baseDir = join(workspace, 'learn');
    cfg = loadConfig({});
  } else {
    try {
      cfg = loadConfig({ projectConfigPath: join(workspace, 'learn', 'config.yaml') });
    } catch (e) {
      err(`error: failed to load config: ${(e as Error).message}\n`);
      return { exitCode: 2, message: 'config-load-failed' };
    }
    baseDir = cfg.storage.base_dir.replace('$WORKSPACE', workspace);
    dbPath = join(baseDir, 'candidates.db');
    candidatesDir = cfg.storage.candidates_dir.replace('$WORKSPACE', workspace);
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

  const collector = new TrialCollector({ store, batchSize: 16, mockPhase1aAssertions: true });
  const runner = new ShadowRunner({ store, collector });

  const graduatedDir = join(baseDir, 'graduated');
  const auditDir = cfg.storage.audit_dir.replace('$WORKSPACE', workspace);
  mkdirSync(graduatedDir, { recursive: true });
  mkdirSync(auditDir, { recursive: true });

  const executor = new GraduationExecutor({
    store,
    workspaceDir: workspace,
    graduatedDir,
    auditDir,
  });

  const thresholds = thresholdsFromConfig(
    cfg.shadow,
    cfg.decision.confidence_threshold.high,
    cfg.decision.confidence_threshold.low,
  );

  try {
    const report = await runCycle({
      store,
      collector,
      runner,
      executor,
      runtimes: flags.runtimes,
      since: flags.since,
      thresholds,
      dryRun: !flags.execute,
      // T-058c-Lite · Phase 1a mock baseline
      // baseline=10x 0，trial.completion_rate 被 collector 提升到 1，
      // L2 走 zero_variance_fallback，rel_delta=1.0 > 0.1 → status='pass'，
      // 配合 mock L1 pass → truth table row #2 → graduated。
      // **TODO(T-058c v2):** 接入 BaselineMetricStore 后移除。
      baselineProvider: () => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });

    if (flags.format === 'json') {
      out(JSON.stringify(report, null, 2) + '\n');
    } else {
      out(renderTable(report));
    }

    return { exitCode: 0, report };
  } finally {
    if (ownsStore) store.close();
  }
}
