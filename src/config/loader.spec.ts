/**
 * T-P1a-010 — Config Loader tests.
 * Covers design §11.1 / §11.4 + test cases #82 / #105.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigLoader,
  loadConfig,
  reloadConfig,
  snapshotConfig,
  __resetConfigForTests,
  LearnConfigSchema,
} from './loader.js';

// ─── Test Fixture Helpers ───────────────────────────

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'll-cfg-'));
}

function writeYaml(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

const MINIMAL_VALID = `
shadow:
  min_trials: 4
`;

// ─── Isolated env sandbox ───────────────────────────

/** Snapshot OPENCLAW_LEARN_* env keys, clear them, restore on teardown. */
class EnvSandbox {
  private snapshot: Record<string, string | undefined> = {};
  begin(): void {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('OPENCLAW_LEARN_')) {
        this.snapshot[k] = process.env[k];
        delete process.env[k];
      }
    }
  }
  set(k: string, v: string): void {
    process.env[k] = v;
  }
  end(): void {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('OPENCLAW_LEARN_')) delete process.env[k];
    }
    for (const [k, v] of Object.entries(this.snapshot)) {
      if (v !== undefined) process.env[k] = v;
    }
    this.snapshot = {};
  }
}

// ─── Suite ──────────────────────────────────────────

describe('ConfigLoader — schema & defaults', () => {
  it('LearnConfigSchema parses empty object with full defaults', () => {
    const parsed = LearnConfigSchema.parse({});
    expect(parsed.shadow.min_trials).toBe(3);
    expect(parsed.decision.confidence_threshold.high).toBe(0.7);
    expect(parsed.storage.base_dir).toBe('$WORKSPACE/learn');
    expect(parsed.storage.max_jsonl_size_kb).toBe(500);
  });

  it('LearnConfigSchema rejects invalid type (min_trials string)', () => {
    expect(() => LearnConfigSchema.parse({ shadow: { min_trials: 'oops' } })).toThrow();
  });

  it('LearnConfigSchema accepts v5.0.5 dual-path adapter fields', () => {
    const parsed = LearnConfigSchema.parse({
      collect: {
        adapters: [
          { name: 'openclaw', agents_root: '~/.openclaw/agents', legacy_session_dir: '~/.openclaw/sessions' },
        ],
      },
    });
    expect(parsed.collect.adapters[0]!.agents_root).toBe('~/.openclaw/agents');
    expect(parsed.collect.adapters[0]!.legacy_session_dir).toBe('~/.openclaw/sessions');
  });
});

describe('ConfigLoader — file loading', () => {
  let tmp: string;
  const envSbx = new EnvSandbox();

  beforeEach(() => { tmp = makeTmp(); envSbx.begin(); __resetConfigForTests(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); envSbx.end(); __resetConfigForTests(); });

  it('loads project yaml when user yaml missing', () => {
    const proj = join(tmp, 'project.yaml');
    writeYaml(proj, MINIMAL_VALID);
    const loader = ConfigLoader.load({ projectConfigPath: proj, userConfigPath: join(tmp, 'nope.yaml'), env: {} });
    expect(loader.get().shadow.min_trials).toBe(4);
  });

  it('loads user yaml when project yaml missing', () => {
    const user = join(tmp, 'user.yaml');
    writeYaml(user, 'decision:\n  confidence_threshold:\n    high: 0.9\n');
    const loader = ConfigLoader.load({ projectConfigPath: join(tmp, 'nope.yaml'), userConfigPath: user, env: {} });
    expect(loader.get().decision.confidence_threshold.high).toBe(0.9);
  });

  it('project overrides user (project > user)', () => {
    const user = join(tmp, 'user.yaml');
    const proj = join(tmp, 'project.yaml');
    writeYaml(user, 'shadow:\n  min_trials: 2\n');
    writeYaml(proj, 'shadow:\n  min_trials: 7\n');
    const loader = ConfigLoader.load({ projectConfigPath: proj, userConfigPath: user, env: {} });
    expect(loader.get().shadow.min_trials).toBe(7);
  });

  it('falls back to defaults when no yaml exists', () => {
    const loader = ConfigLoader.load({
      projectConfigPath: join(tmp, 'none1.yaml'),
      userConfigPath: join(tmp, 'none2.yaml'),
      env: {},
    });
    expect(loader.get().shadow.min_trials).toBe(3);
  });

  it('throws on malformed YAML at initial load', () => {
    const proj = join(tmp, 'bad.yaml');
    writeYaml(proj, 'shadow:\n  min_trials: [unclosed\n');
    expect(() => ConfigLoader.load({ projectConfigPath: proj, userConfigPath: join(tmp, 'x'), env: {} })).toThrow(/parse/i);
  });

  it('throws on schema validation failure at initial load', () => {
    const proj = join(tmp, 'bad.yaml');
    writeYaml(proj, 'shadow:\n  min_trials: "three"\n');
    expect(() => ConfigLoader.load({ projectConfigPath: proj, userConfigPath: join(tmp, 'x'), env: {} })).toThrow(/validation/i);
  });
});

describe('ConfigLoader — env overrides (#82 config_priority_env_over_file)', () => {
  let tmp: string;
  const envSbx = new EnvSandbox();

  beforeEach(() => { tmp = makeTmp(); envSbx.begin(); __resetConfigForTests(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); envSbx.end(); __resetConfigForTests(); });

  it('#82 env OPENCLAW_LEARN_SHADOW_MIN_TRIALS overrides project yaml value', () => {
    const proj = join(tmp, 'project.yaml');
    writeYaml(proj, 'shadow:\n  min_trials: 4\n');
    const loader = ConfigLoader.load({
      projectConfigPath: proj,
      userConfigPath: join(tmp, 'none'),
      env: { OPENCLAW_LEARN_SHADOW_MIN_TRIALS: '9' },
    });
    expect(loader.get().shadow.min_trials).toBe(9);
  });

  it('env parses boolean true/false', () => {
    const loader = ConfigLoader.load({
      projectConfigPath: join(tmp, 'x'),
      userConfigPath: join(tmp, 'y'),
      env: {
        OPENCLAW_LEARN_DECISION_L3_ENABLED: 'true',
        OPENCLAW_LEARN_BRIDGE_AUTO_PUBLISH: 'false',
      },
    });
    expect(loader.get().decision.l3_enabled).toBe(true);
    expect(loader.get().bridge.auto_publish).toBe(false);
  });

  it('env parses float (confidence_threshold.high)', () => {
    const loader = ConfigLoader.load({
      projectConfigPath: join(tmp, 'x'),
      userConfigPath: join(tmp, 'y'),
      env: { OPENCLAW_LEARN_DECISION_CONFIDENCE_THRESHOLD_HIGH: '0.85' },
    });
    expect(loader.get().decision.confidence_threshold.high).toBe(0.85);
  });

  it('env parses JSON array for exclude_labels', () => {
    const loader = ConfigLoader.load({
      projectConfigPath: join(tmp, 'x'),
      userConfigPath: join(tmp, 'y'),
      env: { OPENCLAW_LEARN_COLLECT_FILTERS_EXCLUDE_LABELS: '["test","debug","wip"]' },
    });
    expect(loader.get().collect.filters.exclude_labels).toEqual(['test', 'debug', 'wip']);
  });

  it('env overrides both user and project (env > project > user)', () => {
    const user = join(tmp, 'user.yaml');
    const proj = join(tmp, 'project.yaml');
    writeYaml(user, 'shadow:\n  min_trials: 2\n');
    writeYaml(proj, 'shadow:\n  min_trials: 5\n');
    const loader = ConfigLoader.load({
      projectConfigPath: proj,
      userConfigPath: user,
      env: { OPENCLAW_LEARN_SHADOW_MIN_TRIALS: '11' },
    });
    expect(loader.get().shadow.min_trials).toBe(11);
  });

  it('env parses string value (fallback)', () => {
    const loader = ConfigLoader.load({
      projectConfigPath: join(tmp, 'x'),
      userConfigPath: join(tmp, 'y'),
      env: { OPENCLAW_LEARN_REFLECT_MODEL: 'gpt-5.4' },
    });
    expect(loader.get().reflect.model).toBe('gpt-5.4');
  });

  it('env reads from process.env by default', () => {
    process.env.OPENCLAW_LEARN_SHADOW_MAX_DAILY = '42';
    const loader = ConfigLoader.load({
      projectConfigPath: join(tmp, 'x'),
      userConfigPath: join(tmp, 'y'),
      // env omitted → uses process.env
    });
    expect(loader.get().shadow.max_daily).toBe(42);
  });
});

describe('ConfigLoader — double-buffered reload (§11.4)', () => {
  let tmp: string;
  const envSbx = new EnvSandbox();

  beforeEach(() => { tmp = makeTmp(); envSbx.begin(); __resetConfigForTests(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); envSbx.end(); __resetConfigForTests(); });

  it('reload picks up edited yaml and reports changed_sections', () => {
    const proj = join(tmp, 'project.yaml');
    writeYaml(proj, 'shadow:\n  min_trials: 3\n');
    const loader = ConfigLoader.load({ projectConfigPath: proj, userConfigPath: join(tmp, 'x'), env: {} });
    writeYaml(proj, 'shadow:\n  min_trials: 8\n');
    const r = loader.reload();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.shadow.min_trials).toBe(8);
      expect(r.changed_sections).toContain('shadow');
    }
  });

  it('reload with no change returns empty changed_sections', () => {
    const proj = join(tmp, 'project.yaml');
    writeYaml(proj, MINIMAL_VALID);
    const loader = ConfigLoader.load({ projectConfigPath: proj, userConfigPath: join(tmp, 'x'), env: {} });
    const r = loader.reload();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed_sections).toEqual([]);
  });

  it('reload keeps OLD config when new YAML has parse error', () => {
    const proj = join(tmp, 'project.yaml');
    writeYaml(proj, 'shadow:\n  min_trials: 6\n');
    const loader = ConfigLoader.load({ projectConfigPath: proj, userConfigPath: join(tmp, 'x'), env: {} });
    expect(loader.get().shadow.min_trials).toBe(6);
    writeYaml(proj, 'shadow:\n  min_trials: [broken\n');
    const r = loader.reload();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe('config_parse_error');
    expect(loader.get().shadow.min_trials).toBe(6); // unchanged
  });

  it('reload keeps OLD config when new YAML fails schema validation', () => {
    const proj = join(tmp, 'project.yaml');
    writeYaml(proj, 'shadow:\n  min_trials: 6\n');
    const loader = ConfigLoader.load({ projectConfigPath: proj, userConfigPath: join(tmp, 'x'), env: {} });
    writeYaml(proj, 'shadow:\n  min_trials: "not_a_number"\n');
    const r = loader.reload();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error_code).toBe('config_validation_error');
    expect(loader.get().shadow.min_trials).toBe(6);
  });

  it('reload error includes audit-friendly message', () => {
    const proj = join(tmp, 'project.yaml');
    writeYaml(proj, MINIMAL_VALID);
    const loader = ConfigLoader.load({ projectConfigPath: proj, userConfigPath: join(tmp, 'x'), env: {} });
    writeYaml(proj, 'shadow:\n  min_trials: -1\n'); // positive int constraint fails
    const r = loader.reload();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message.length).toBeGreaterThan(0);
      expect(r.error_code).toBe('config_validation_error');
    }
  });

  it('reload picks up new env overrides', () => {
    const proj = join(tmp, 'project.yaml');
    writeYaml(proj, 'shadow:\n  min_trials: 3\n');
    const loader = ConfigLoader.load({ projectConfigPath: proj, userConfigPath: join(tmp, 'x'), env: {} });
    const r = loader.reload({
      projectConfigPath: proj,
      userConfigPath: join(tmp, 'x'),
      env: { OPENCLAW_LEARN_SHADOW_MIN_TRIALS: '15' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.shadow.min_trials).toBe(15);
  });
});

describe('ConfigLoader — snapshot (#105 trial snapshot isolation)', () => {
  let tmp: string;
  const envSbx = new EnvSandbox();

  beforeEach(() => { tmp = makeTmp(); envSbx.begin(); __resetConfigForTests(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); envSbx.end(); __resetConfigForTests(); });

  it('snapshot returns deep clone (mutating it does not affect loader)', () => {
    const loader = ConfigLoader.load({
      projectConfigPath: join(tmp, 'x'),
      userConfigPath: join(tmp, 'y'),
      env: {},
    });
    const snap = loader.snapshot();
    (snap.shadow as any).min_trials = 999;
    expect(loader.get().shadow.min_trials).toBe(3);
  });

  it('#105 config_reload_during_inflight_trial_uses_snapshot', () => {
    // Setup: trial starts with min_trials=3
    const proj = join(tmp, 'project.yaml');
    writeYaml(proj, 'shadow:\n  min_trials: 3\n');
    const loader = ConfigLoader.load({ projectConfigPath: proj, userConfigPath: join(tmp, 'x'), env: {} });

    // Trial begins → freezes snapshot
    const inFlightTrialSnapshot = loader.snapshot();
    expect(inFlightTrialSnapshot.shadow.min_trials).toBe(3);

    // Operator reloads config mid-flight with new value
    writeYaml(proj, 'shadow:\n  min_trials: 10\n');
    const r = loader.reload();
    expect(r.ok).toBe(true);

    // Live config reflects new value
    expect(loader.get().shadow.min_trials).toBe(10);

    // BUT in-flight trial's frozen snapshot is UNCHANGED — the key invariant
    expect(inFlightTrialSnapshot.shadow.min_trials).toBe(3);

    // New trials started AFTER reload see new config
    const newTrialSnapshot = loader.snapshot();
    expect(newTrialSnapshot.shadow.min_trials).toBe(10);
  });
});

describe('ConfigLoader — module singleton API', () => {
  let tmp: string;
  const envSbx = new EnvSandbox();

  beforeEach(() => { tmp = makeTmp(); envSbx.begin(); __resetConfigForTests(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); envSbx.end(); __resetConfigForTests(); });

  it('loadConfig returns singleton (same instance on repeat call)', () => {
    const a = loadConfig({ projectConfigPath: join(tmp, 'x'), userConfigPath: join(tmp, 'y'), env: {} });
    const b = loadConfig();
    expect(a).toBe(b);
  });

  it('reloadConfig lazy-initializes when not yet loaded', () => {
    const r = reloadConfig({ projectConfigPath: join(tmp, 'x'), userConfigPath: join(tmp, 'y'), env: {} });
    expect(r.ok).toBe(true);
  });

  it('snapshotConfig throws when loader not initialized', () => {
    expect(() => snapshotConfig()).toThrow(/not loaded/);
  });

  it('snapshotConfig works after loadConfig', () => {
    loadConfig({ projectConfigPath: join(tmp, 'x'), userConfigPath: join(tmp, 'y'), env: {} });
    const snap = snapshotConfig();
    expect(snap.shadow.min_trials).toBe(3);
  });
});
