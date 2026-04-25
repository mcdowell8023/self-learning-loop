/**
 * T-P1a-010 — Config schema facade.
 *
 * Re-exports the authoritative zod schema from kernel/schemas/config.ts so
 * the `src/config/` module has a stable local import path per ticket spec.
 *
 * Ref: learning-loop-design-v5.0.5.md §11.2
 * @module
 */
export { LearnConfigSchema, } from '../kernel/schemas/config.js';
