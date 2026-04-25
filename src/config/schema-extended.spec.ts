// src/config/schema-extended.spec.ts
import { describe, it, expect } from 'vitest';
import { LearnConfigSchema } from './schema.js';

describe('config schema extensions (T-SLL-006)', () => {
  it('reflect defaults include new fields', () => {
    const config = LearnConfigSchema.parse({});
    expect(config.reflect.daily_token_budget).toBe(50000);
    expect(config.reflect.min_confidence).toBe(0.65);
    expect(config.reflect.dedup_threshold).toBe(0.85);
  });

  it('shadow defaults include top-level convenience fields', () => {
    const config = LearnConfigSchema.parse({});
    expect(config.shadow.max_same_session_ratio).toBe(0.3);
    expect(config.shadow.min_unique_sessions).toBe(5);
  });

  it('reflect fields are customizable', () => {
    const config = LearnConfigSchema.parse({
      reflect: {
        daily_token_budget: 100000,
        min_confidence: 0.8,
        dedup_threshold: 0.95,
      },
    });
    expect(config.reflect.daily_token_budget).toBe(100000);
    expect(config.reflect.min_confidence).toBe(0.8);
    expect(config.reflect.dedup_threshold).toBe(0.95);
  });

  it('shadow top-level fields are customizable', () => {
    const config = LearnConfigSchema.parse({
      shadow: {
        max_same_session_ratio: 0.5,
        min_unique_sessions: 10,
      },
    });
    expect(config.shadow.max_same_session_ratio).toBe(0.5);
    expect(config.shadow.min_unique_sessions).toBe(10);
  });

  it('existing fields are preserved', () => {
    const config = LearnConfigSchema.parse({});
    expect(config.reflect.max_candidates_per_session).toBe(3);
    expect(config.reflect.model).toBe('claude-sonnet-4.6');
    expect(config.shadow.min_trials).toBe(3);
    expect(config.shadow.sample_bias_protection.enabled).toBe(true);
  });
});
