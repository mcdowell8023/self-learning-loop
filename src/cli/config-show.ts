// src/cli/config-show.ts
//
// CLI: `openclaw-learn config show` — Display current configuration.

import { loadConfig, type LoaderOptions } from '../config/loader.js';
import type { LearnConfig } from '../config/schema.js';

export interface ConfigShowRunOptions {
  argv: string[];
  cwd?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export interface ConfigShowResult {
  exitCode: number;
  message?: string;
}

export async function runConfigShow(opts: ConfigShowRunOptions): Promise<ConfigShowResult> {
  const out = opts.stdout ?? ((s: string) => process.stdout.write(s));
  const err = opts.stderr ?? ((s: string) => process.stderr.write(s));

  let jsonOutput = false;
  let keyFilter: string | undefined;

  for (let i = 0; i < opts.argv.length; i++) {
    const tok = opts.argv[i]!;
    if (tok === '--json') jsonOutput = true;
    else if (tok === '--key' && opts.argv[i + 1]) keyFilter = opts.argv[++i];
    else if (tok.startsWith('--key=')) keyFilter = tok.slice('--key='.length);
    else if (tok === '-h' || tok === '--help') {
      out(
        'Usage: openclaw-learn config show [--json] [--key <path>]\n\n' +
        'Options:\n' +
        '  --json          Output as JSON.\n' +
        '  --key <path>    Show a single config key (dot-separated path).\n',
      );
      return { exitCode: 0 };
    }
  }

  let config: LearnConfig;
  try {
    config = loadConfig();
  } catch (e) {
    err(`error: failed to load config: ${(e as Error).message}\n`);
    return { exitCode: 1, message: 'load failed' };
  }

  if (keyFilter) {
    const value = getNestedValue(config, keyFilter);
    if (value === undefined) {
      err(`error: key not found: ${keyFilter}\n`);
      return { exitCode: 3, message: 'key not found' };
    }
    if (jsonOutput) {
      out(JSON.stringify(value, null, 2) + '\n');
    } else {
      out(`${keyFilter} = ${typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}\n`);
    }
    return { exitCode: 0 };
  }

  if (jsonOutput) {
    out(JSON.stringify(config, null, 2) + '\n');
  } else {
    renderConfig(config, out);
  }
  return { exitCode: 0 };
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

function renderConfig(config: LearnConfig, out: (s: string) => void, prefix = ''): void {
  for (const [key, value] of Object.entries(config)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      out(`${fullKey}:\n`);
      renderConfig(value as any, out, fullKey);
    } else {
      out(`  ${fullKey} = ${JSON.stringify(value)}\n`);
    }
  }
}
