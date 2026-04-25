// scripts/override-demo.mjs — live demo for T-P1a-009 self-check.
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { runOverride } from '../dist/cli/override.js';
import { openCandidateStore } from '../dist/store/candidate-store.js';

const root = mkdtempSync(join(tmpdir(), 'override-demo-'));
const dbPath = join(root, 'learn', 'candidates.db');
const store = openCandidateStore({
  dbPath,
  defaultActor: 'system',
  migrationsDir: new URL('../src/store/migrations/', import.meta.url).pathname,
});

const sid = createHash('sha256').update('demo-' + Date.now()).digest('hex');
const strategy = {
  strategy_id: sid,
  problem_category: 'cleanup',
  trigger_conditions: 'after task completion',
  recommended_action: 'clean /tmp/<prefix>*',
  scope: 'general',
  tags: ['demo'],
  created_at: new Date().toISOString(),
  instance_ids: [sid + '-i'],
};
const instance = {
  instance_id: sid + '-i',
  strategy_id: sid,
  diff_summary: 'demo diff',
  files_touched: ['AGENTS.md'],
  env_fingerprint: { runtime: 'openclaw', platform: 'linux', arch: 'x64' },
  source_sessions: [{ session_id: 's-demo', runtime: 'openclaw', timestamp: new Date().toISOString() }],
  assertions: [],
  trial_results: [],
  created_at: new Date().toISOString(),
};
store.create({ strategy, instances: [instance] });
console.log('[demo] seeded candidate', sid, 'state=pending');

const res = await runOverride({
  cwd: root,
  store,
  argv: ['force-graduate', sid, '--reason', 'manual-approval demo run'],
  stdout: (s) => process.stdout.write('[cli] ' + s),
  stderr: (s) => process.stderr.write('[cli-err] ' + s),
});

console.log('[demo] exit code:', res.exitCode);
console.log('[demo] from → to  :', res.fromState, '→', res.toState);
console.log('[demo] wrote artifact:', res.wroteArtifact);
console.log('[demo] state after:', store.get(sid).state);

const auditPath = join(root, 'learn', 'audit', 'overrides.jsonl');
console.log('[demo] audit path exists:', existsSync(auditPath));
console.log('[demo] audit content:');
console.log(readFileSync(auditPath, 'utf-8'));

store.close();
rmSync(root, { recursive: true, force: true });
console.log('[demo] cleaned tmp dir');
