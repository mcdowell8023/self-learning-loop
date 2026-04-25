/**
 * Adapter registry unit tests.
 * T-SLL-002a — 3 test cases.
 */
import { describe, expect, it } from 'vitest';
import { getAdapter, listBuiltinRuntimes } from '../registry.js';
import { OpenClawAdapter } from '../openclaw.js';
describe('adapter-registry', () => {
    it('getAdapter("openclaw") returns OpenClawAdapter instance', async () => {
        const adapter = await getAdapter('openclaw');
        expect(adapter).toBeInstanceOf(OpenClawAdapter);
        expect(adapter.id).toBe('openclaw');
    });
    it('throws on unknown runtime', async () => {
        await expect(getAdapter('nonexistent-runtime-xyz')).rejects.toThrow(/No adapter found for runtime "nonexistent-runtime-xyz"/);
    });
    it('listBuiltinRuntimes includes openclaw', () => {
        const runtimes = listBuiltinRuntimes();
        expect(runtimes).toContain('openclaw');
    });
});
