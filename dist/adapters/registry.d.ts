import type { RuntimeAdapter } from './base.js';
export type RuntimeId = 'openclaw' | 'claude-code' | 'opencode' | 'codex' | 'generic';
/**
 * Get a RuntimeAdapter instance for the given runtime.
 *
 * Resolution order:
 * 1. Built-in factory (openclaw, claude-code, opencode, generic)
 * 2. Three-tier discovery (local → global → npm)
 * 3. Throw if not found.
 */
export declare function getAdapter(runtime: string): Promise<RuntimeAdapter>;
/**
 * List all built-in runtime IDs.
 */
export declare function listBuiltinRuntimes(): RuntimeId[];
