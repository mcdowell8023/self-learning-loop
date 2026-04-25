/**
 * Adapter Registry — factory for RuntimeAdapter instances with three-tier discovery.
 * Ref: self-learning-loop-skill-design-v1.1.md §4.4
 * @module
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { RuntimeAdapter } from './base.js';
import { OpenClawAdapter } from './openclaw.js';

// ─── Types ──────────────────────────────────────────

export type RuntimeId = 'openclaw' | 'claude-code' | 'opencode' | 'codex' | 'generic';

type AdapterFactory = () => RuntimeAdapter;

// ─── Built-in registry ──────────────────────────────

const builtinFactories = new Map<RuntimeId, AdapterFactory>([
  ['openclaw', () => new OpenClawAdapter()],
  // claude-code, opencode, generic — stub factories; real implementations in future tickets
]);

// ─── Three-tier discovery paths ─────────────────────

function getDiscoveryPaths(): string[] {
  const home = homedir();
  return [
    join(home, '.openclaw/workspace/skills/learning-loop-adapters'),  // local
    join(home, '.local/share/openclaw-learn/adapters'),               // global
    // npm tier: @openclaw/learn-adapter-* (require-based, checked last)
  ];
}

/**
 * Try to load an adapter from the three-tier discovery chain.
 * Returns undefined if nothing found.
 */
async function discoverAdapter(runtime: string): Promise<RuntimeAdapter | undefined> {
  // Tier 1 & 2: filesystem paths
  for (const dir of getDiscoveryPaths()) {
    const candidate = join(dir, `${runtime}.js`);
    if (existsSync(candidate)) {
      try {
        const mod = await import(candidate);
        if (typeof mod.default === 'function') {
          return new mod.default() as RuntimeAdapter;
        }
        if (typeof mod.createAdapter === 'function') {
          return mod.createAdapter() as RuntimeAdapter;
        }
      } catch {
        // Skip broken adapters
      }
    }
  }

  // Tier 3: npm package
  const npmPkg = `@openclaw/learn-adapter-${runtime}`;
  try {
    const mod = await import(npmPkg);
    if (typeof mod.default === 'function') {
      return new mod.default() as RuntimeAdapter;
    }
    if (typeof mod.createAdapter === 'function') {
      return mod.createAdapter() as RuntimeAdapter;
    }
  } catch {
    // Package not installed — that's fine
  }

  return undefined;
}

// ─── Public API ─────────────────────────────────────

/**
 * Get a RuntimeAdapter instance for the given runtime.
 *
 * Resolution order:
 * 1. Built-in factory (openclaw, claude-code, opencode, generic)
 * 2. Three-tier discovery (local → global → npm)
 * 3. Throw if not found.
 */
export async function getAdapter(runtime: string): Promise<RuntimeAdapter> {
  // Check built-in first
  const factory = builtinFactories.get(runtime as RuntimeId);
  if (factory) return factory();

  // Three-tier discovery
  const discovered = await discoverAdapter(runtime);
  if (discovered) return discovered;

  throw new Error(
    `No adapter found for runtime "${runtime}". ` +
    `Built-in runtimes: ${[...builtinFactories.keys()].join(', ')}. ` +
    `You can install a community adapter via npm: @openclaw/learn-adapter-${runtime}`,
  );
}

/**
 * List all built-in runtime IDs.
 */
export function listBuiltinRuntimes(): RuntimeId[] {
  return [...builtinFactories.keys()];
}
