// src/cli/config-show.ts
//
// CLI: `openclaw-learn config show` — Display current configuration
// with three-column output: field / value / source.
// T-SLL-006

import { loadConfig, getConfigSources, __resetConfigForTests, type LoaderOptions } from '../config/loader.js';
import type { LearnConfig } from '../config/schema.js';
import { join } from 'node:path';
import { resolveWorkspace } from './workspace-resolver.js';

export interface ConfigShowRunOptions {
  argv: string[];
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Override loader options (for testing). */
  loaderOpts?: LoaderOptions;
}

export interface ConfigShowResult {
  exitCode: number;
  message?: string;
}

export async function runConfigShow(opts: ConfigShowRunOptions): Promise<ConfigShowResult> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));

  let format: 'table' | 'json' = 'table';
  let keyFilter: string | undefined;

  for (let i = 0; i < opts.argv.length; i++) {
    const tok = opts.argv[i]!;
    if (tok === '--json') format = 'json';
    else if (tok === '--format' && opts.argv[i + 1]) {
      const f = opts.argv[++i]!;
      if (f === 'json' || f === 'table') format = f;
      else {
        err(`error: unknown format "${f}". Use "json" or "table".\n`);
        return { exitCode: 1, message: 'bad format' };
      }
    } else if (tok.startsWith('--format=')) {
      const f = tok.slice('--format='.length);
      if (f === 'json' || f === 'table') format = f;
      else {
        err(`error: unknown format "${f}". Use "json" or "table".\n`);
        return { exitCode: 1, message: 'bad format' };
      }
    } else if (tok === '--key' && opts.argv[i + 1]) keyFilter = opts.argv[++i];
    else if (tok.startsWith('--key=')) keyFilter = tok.slice('--key='.length);
    else if (tok === '-h' || tok === '--help') {
      out(
        'Usage: openclaw-learn config show [--format json|table] [--json] [--key <path>]\n\n' +
        'Options:\n' +
        '  --format <fmt>  Output format: "table" (default) or "json".\n' +
        '  --json          Shorthand for --format json.\n' +
        '  --key <path>    Show a single config key (dot-separated path).\n',
      );
      return { exitCode: 0 };
    }
  }

  // Reset singleton so we get fresh source tracking
  __resetConfigForTests();

  let config: LearnConfig;
  try {
    if (opts.loaderOpts) {
      config = loadConfig(opts.loaderOpts);
    } else {
      const { workspace } = resolveWorkspace({ cwd: process.cwd(), env: process.env });
      config = loadConfig({ projectConfigPath: join(workspace, 'learn', 'config.yaml') });
    }
  } catch (e) {
    err(`error: failed to load config: ${(e as Error).message}\n`);
    return { exitCode: 1, message: 'load failed' };
  }

  const sources = getConfigSources();

  if (keyFilter) {
    const value = getNestedValue(config, keyFilter);
    if (value === undefined) {
      err(`error: key not found: ${keyFilter}\n`);
      return { exitCode: 3, message: 'key not found' };
    }
    const source = sources.get(keyFilter) ?? 'default';
    if (format === 'json') {
      out(JSON.stringify({ key: keyFilter, value, source }, null, 2) + '\n');
    } else {
      out(`${keyFilter} = ${formatValue(value)}  (${source})\n`);
    }
    return { exitCode: 0 };
  }

  const rows = flattenConfig(config, sources);

  if (format === 'json') {
    out(JSON.stringify(rows, null, 2) + '\n');
  } else {
    renderTable(rows, out);
  }
  return { exitCode: 0 };
}

interface ConfigRow {
  field: string;
  value: unknown;
  source: 'default' | 'config-file' | 'env-var' | 'cli-override';
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function flattenConfig(
  obj: unknown,
  sources: Map<string, string>,
  prefix: string = '',
): ConfigRow[] {
  const rows: ConfigRow[] = [];
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        rows.push(...flattenConfig(value, sources, fullKey));
      } else {
        rows.push({
          field: fullKey,
          value,
          source: (sources.get(fullKey) as ConfigRow['source']) ?? 'default',
        });
      }
    }
  }
  return rows;
}

function renderTable(rows: ConfigRow[], out: (s: string) => void): void {
  // Compute column widths
  const hField = 'Field';
  const hValue = 'Value';
  const hSource = 'Source';
  let maxField = hField.length;
  let maxValue = hValue.length;
  let maxSource = hSource.length;

  const formatted = rows.map(r => {
    const f = r.field;
    const v = formatValue(r.value);
    const s = r.source;
    if (f.length > maxField) maxField = f.length;
    if (v.length > maxValue) maxValue = Math.min(v.length, 60);
    if (s.length > maxSource) maxSource = s.length;
    return { f, v, s };
  });

  // Cap value column
  if (maxValue > 60) maxValue = 60;

  const sep = `${'─'.repeat(maxField + 2)}┼${'─'.repeat(maxValue + 2)}┼${'─'.repeat(maxSource + 2)}`;
  out(`${hField.padEnd(maxField)}  │ ${hValue.padEnd(maxValue)} │ ${hSource}\n`);
  out(`${sep}\n`);

  for (const { f, v, s } of formatted) {
    const truncV = v.length > maxValue ? v.slice(0, maxValue - 3) + '...' : v;
    out(`${f.padEnd(maxField)}  │ ${truncV.padEnd(maxValue)} │ ${s}\n`);
  }
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const p of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}
