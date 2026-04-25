// src/cli/workspace-resolver.ts
//
// Resolve the workspace directory using a priority chain:
//   1. --workspace flag
//   2. $LEARNING_LOOP_WORKSPACE env
//   3. $OPENCLAW_WORKSPACE env
//   4. Auto-detect (probe known runtime paths for learn/candidates.db)
//   5. Fallback to cwd

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface ResolveOptions {
  workspaceFlag?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeOverride?: string;
}

export interface ResolvedWorkspace {
  workspace: string;
  source: 'flag' | 'env-llm' | 'env-openclaw' | 'detected' | 'cwd-fallback';
}

export function resolveWorkspace(opts: ResolveOptions = {}): ResolvedWorkspace {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const home = opts.homeOverride ?? homedir();

  // 1. --workspace flag (highest priority)
  if (opts.workspaceFlag) {
    const ws = isAbsolute(opts.workspaceFlag)
      ? opts.workspaceFlag
      : resolve(cwd, opts.workspaceFlag);
    return { workspace: ws, source: 'flag' };
  }

  // 2. $LEARNING_LOOP_WORKSPACE
  if (env.LEARNING_LOOP_WORKSPACE) {
    return { workspace: env.LEARNING_LOOP_WORKSPACE, source: 'env-llm' };
  }

  // 3. $OPENCLAW_WORKSPACE
  if (env.OPENCLAW_WORKSPACE) {
    return { workspace: env.OPENCLAW_WORKSPACE, source: 'env-openclaw' };
  }

  // 4. Auto-detect: probe known runtime paths
  const candidates = [
    join(home, '.openclaw', 'workspace'),
    join(home, '.local', 'share', 'opencode'),
    join(home, '.claude'),
    join(home, '.codex'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'learn', 'candidates.db'))) {
      return { workspace: c, source: 'detected' };
    }
  }

  // 5. Fallback: cwd
  return { workspace: cwd, source: 'cwd-fallback' };
}
