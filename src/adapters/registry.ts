/**
 * Adapter Registry — factory for RuntimeAdapter instances with three-tier discovery.
 * Ref: self-learning-loop-skill-design-v1.1.md §4.4
 * @module
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { RuntimeAdapter } from './base.js';
import { GenericAdapter } from './generic.js';
import { OpenClawAdapter } from './openclaw.js';

// ─── Types ──────────────────────────────────────────

export type RuntimeId = 'openclaw' | 'claude-code' | 'opencode' | 'codex' | 'generic';

type AdapterFactory = () => RuntimeAdapter;

// ─── Built-in registry ──────────────────────────────

/**
 * Discover codex.yaml via a multi-step chain:
 * 1. LEARN_ADAPTERS_DIR env var
 * 2. <package dir>/configs/adapters/  (relative to this file)
 * 3. <cwd>/configs/adapters/
 * 4. Source repo fallback
 */
function discoverCodexYaml(): string {
  const filename = 'codex.yaml';

  // 1. Env override
  if (process.env.LEARN_ADAPTERS_DIR) {
    const p = join(process.env.LEARN_ADAPTERS_DIR, filename);
    if (existsSync(p)) return p;
  }

  // 2. Relative to this module (works after setup.sh copies configs/)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = join(thisDir, '..'); // dist/ -> package root
  const pkgPath = join(pkgRoot, 'configs/adapters', filename);
  if (existsSync(pkgPath)) return pkgPath;

  // 3. CWD-based
  const cwdPath = join(process.cwd(), 'configs/adapters', filename);
  if (existsSync(cwdPath)) return cwdPath;

  // 4. Source repo fallback
  const fallback = join(homedir(), 'open-claw-output/code/learning-loop/configs/adapters', filename);
  return fallback; // may not exist — GenericAdapter constructor will throw
}

const builtinFactories = new Map<RuntimeId, AdapterFactory>([
  ['openclaw', () => new OpenClawAdapter()],
  ['codex', () => new GenericAdapter(discoverCodexYaml())],
  // claude-code, opencode — stub factories; real implementations in future tickets
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
