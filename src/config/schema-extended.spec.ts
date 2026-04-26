// src/config/schema-extended.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { LearnConfigSchema } from './schema.js';
import { ConfigLoader, interpolateEnvVars, __resetConfigForTests } from './loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('config schema extensions (T-SLL-006)', () => {
  // --- Existing tests (preserved) ---

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

  // --- New T-SLL-006 tests ---

  it('runtime field defaults to auto', () => {
    const config = LearnConfigSchema.parse({});
    expect(config.runtime).toBe('auto');
  });

  it('runtime accepts all valid values', () => {
    for (const rt of ['openclaw', 'claude-code', 'opencode', 'codex', 'auto'] as const) {
      const config = LearnConfigSchema.parse({ runtime: rt });
      expect(config.runtime).toBe(rt);
    }
  });

  it('runtime rejects invalid values', () => {
    expect(() => LearnConfigSchema.parse({ runtime: 'invalid' })).toThrow();
  });

  it('paths defaults use ${HOME} template', () => {
    const config = LearnConfigSchema.parse({});
    expect(config.paths.skills_dir).toContain('${HOME}');
    expect(config.paths.data_dir).toContain('${HOME}');
    expect(config.paths.memory_dir).toContain('${HOME}');
  });

  it('paths are customizable', () => {
    const config = LearnConfigSchema.parse({
      paths: { skills_dir: '/custom/skills', data_dir: '/custom/data', memory_dir: '/custom/mem' },
    });
    expect(config.paths.skills_dir).toBe('/custom/skills');
    expect(config.paths.data_dir).toBe('/custom/data');
    expect(config.paths.memory_dir).toBe('/custom/mem');
  });

  it('triggers defaults to empty arrays', () => {
    const config = LearnConfigSchema.parse({});
    expect(config.triggers.openclaw).toEqual([]);
    expect(config.triggers['claude-code']).toEqual([]);
    expect(config.triggers.opencode).toEqual([]);
    expect(config.triggers.codex).toEqual([]);
  });

  it('triggers accept valid entries', () => {
    const config = LearnConfigSchema.parse({
      triggers: {
        opencode: [{ event: 'session.idle', handler: 'reflect', enabled: true }],
      },
    });
    expect(config.triggers.opencode).toHaveLength(1);
    expect(config.triggers.opencode[0].event).toBe('session.idle');
  });

  it('backward compat: old config without new fields parses fine', () => {
    const oldConfig = {
      collect: { filters: { min_turns: 5 } },
      reflect: { model: 'gpt-5-mini' },
    };
    const config = LearnConfigSchema.parse(oldConfig);
    // New fields get defaults
    expect(config.runtime).toBe('auto');
    expect(config.paths.skills_dir).toContain('${HOME}');
    expect(config.triggers.openclaw).toEqual([]);
    // Old fields preserved
    expect(config.collect.filters.min_turns).toBe(5);
    expect(config.reflect.model).toBe('gpt-5-mini');
  });
});

describe('env variable interpolation', () => {
  it('interpolates ${VAR} in strings', () => {
    expect(interpolateEnvVars('${HOME}/.openclaw', { HOME: '/home/test' })).toBe('/home/test/.openclaw');
  });

  it('leaves unknown vars as empty string', () => {
    expect(interpolateEnvVars('${UNKNOWN}/path', {})).toBe('/path');
  });

  it('handles multiple vars', () => {
    expect(interpolateEnvVars('${A}/${B}', { A: 'x', B: 'y' })).toBe('x/y');
  });
});

describe('loader env interpolation for paths', () => {
  const tmpBase = join(tmpdir(), 'sll-006-loader-test-' + Date.now());

  beforeEach(() => {
    __resetConfigForTests();
    mkdirSync(tmpBase, { recursive: true });
  });

  it('interpolates paths.* with actual env values', () => {
    const configPath = join(tmpBase, 'config.yaml');
    writeFileSync(configPath, 'paths:\n  skills_dir: "${MY_DIR}/skills"\n');
    const loader = ConfigLoader.load({
      projectConfigPath: configPath,
      userConfigPath: join(tmpBase, 'nonexistent.yaml'),
      env: { MY_DIR: '/resolved' },
    });
    expect(loader.get().paths.skills_dir).toBe('/resolved/skills');
  });
});

describe('config source tracking', () => {
  const tmpBase = join(tmpdir(), 'sll-006-source-test-' + Date.now());

  beforeEach(() => {
    __resetConfigForTests();
    mkdirSync(tmpBase, { recursive: true });
  });

  it('marks all fields as default when no config files', () => {
    const loader = ConfigLoader.load({
      projectConfigPath: join(tmpBase, 'nonexistent.yaml'),
      userConfigPath: join(tmpBase, 'nonexistent2.yaml'),
      env: {},
    });
    const sources = loader.getSources();
    expect(sources.get('runtime')).toBe('default');
    expect(sources.get('paths.skills_dir')).toBe('default');
  });

  it('marks config-file fields correctly', () => {
    const configPath = join(tmpBase, 'config.yaml');
    writeFileSync(configPath, 'runtime: opencode\n');
    const loader = ConfigLoader.load({
      projectConfigPath: configPath,
      userConfigPath: join(tmpBase, 'nonexistent.yaml'),
      env: {},
    });
    const sources = loader.getSources();
    expect(sources.get('runtime')).toBe('config-file');
    expect(sources.get('paths.skills_dir')).toBe('default');
  });

  it('marks env-var fields correctly', () => {
    const loader = ConfigLoader.load({
      projectConfigPath: join(tmpBase, 'nonexistent.yaml'),
      userConfigPath: join(tmpBase, 'nonexistent2.yaml'),
      env: { OPENCLAW_LEARN_RUNTIME: 'codex' },
    });
    const sources = loader.getSources();
    expect(sources.get('runtime')).toBe('env-var');
  });
});
