// src/cli/repair.ts
// T-SLL-003 · `openclaw-learn repair` — 补写缺失/过期的候选文件镜像

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { openCandidateStore } from '../store/candidate-store.js';
import { repairMirrors } from '../store/candidate-mirror.js';
import { loadConfig } from '../config/loader.js';
import { resolveWorkspace } from './workspace-resolver.js';

export interface RepairRunOptions {
  argv: string[];
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

export interface RepairRunResult {
  exitCode: number;
  total?: number;
  written?: number;
  skipped?: number;
}

const USAGE = [
  'Usage: openclaw-learn repair [options]',
  '',
  'Scan SQLite candidates and write missing/stale file mirrors.',
  '',
  'Options:',
  '  --dry-run        Print what would be written without writing.',
  '  --scope <s>      Only repair candidates of a given scope.',
  '  -h, --help       Show this help.',
  '',
].join('\n');

export async function runRepair(opts: RepairRunOptions): Promise<RepairRunResult> {
  const { workspace: cwd } = resolveWorkspace({ cwd: opts.cwd, env: process.env });
  const { argv, stdout, stderr } = opts;

  if (argv.includes('-h') || argv.includes('--help')) {
    stdout(USAGE);
    return { exitCode: 0 };
  }

  const dryRun = argv.includes('--dry-run');
  const scopeIdx = argv.indexOf('--scope');
  const scope = scopeIdx >= 0 ? argv[scopeIdx + 1] : undefined;

  // Resolve paths
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ projectConfigPath: join(cwd, 'learn', 'config.yaml') });
  } catch {
    // fallback defaults
    config = null as any;
  }

  const baseDir = config?.storage?.base_dir?.replace('$WORKSPACE', cwd)
    ?? join(cwd, 'learn');
  const dbPath = join(baseDir, 'candidates.db');
  const candidatesDir = config?.storage?.candidates_dir?.replace('$WORKSPACE', cwd)
    ?? join(baseDir, 'candidates');

  if (!existsSync(dbPath)) {
    stderr(`error: database not found at ${dbPath}. Run 'openclaw-learn init' first.\n`);
    return { exitCode: 1 };
  }

  const store = openCandidateStore({ dbPath });
  try {
    const filter = scope ? { scope: scope as any } : {};
    const candidates = store.list(filter);

    const result = repairMirrors(candidatesDir, candidates, { dryRun });

    if (dryRun) {
      stdout(`[dry-run] Would write ${result.written} mirror(s), skip ${result.skipped} (total ${result.total})\n`);
    } else {
      stdout(`Repaired ${result.written} mirror(s), skipped ${result.skipped} up-to-date (total ${result.total})\n`);
    }

    for (const d of result.details) {
      if (d.action === 'written') {
        stdout(`  ${dryRun ? 'would write' : 'wrote'}: ${d.id}\n`);
      }
    }

    return { exitCode: 0, total: result.total, written: result.written, skipped: result.skipped };
  } finally {
    store.close();
  }
}
