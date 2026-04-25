// src/store/candidate-mirror.ts
// §5.6.2 文件镜像写入 — YAML frontmatter + markdown body
// 原子写入：先写 .tmp，再 rename

import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import YAML from 'yaml';
import type { Candidate } from '../kernel/types.js';

// ---------------------------------------------------------------------------
// Mirror path: <candidatesDir>/<date>/<shortHash>-<problemCategory>.md
// ---------------------------------------------------------------------------

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unknown';
}

export function mirrorFileName(candidate: Candidate): string {
  const date = candidate.created_at.slice(0, 10); // YYYY-MM-DD
  const shortHash = candidate.candidate_id.slice(0, 8);
  const cat = sanitize(candidate.strategy.problem_category);
  return `${date}/${shortHash}-${cat}.md`;
}

export function mirrorPath(candidatesDir: string, candidate: Candidate): string {
  return join(candidatesDir, mirrorFileName(candidate));
}

// ---------------------------------------------------------------------------
// Render candidate → markdown with YAML frontmatter
// ---------------------------------------------------------------------------

export function renderMirror(candidate: Candidate): string {
  const s = candidate.strategy;
  const frontmatter: Record<string, unknown> = {
    id: candidate.candidate_id,
    problem_category: s.problem_category,
    strategy_id: s.strategy_id,
    scope: s.scope,
    state: candidate.state,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
    tags: s.tags ?? [],
    instance_count: candidate.instances.length,
  };

  if (candidate.dormant_reason) {
    frontmatter.dormant_reason = candidate.dormant_reason;
  }

  // Source info from first instance (if any)
  if (candidate.instances.length > 0) {
    const inst = candidate.instances[0]!;
    frontmatter.source_runtime = inst.env_fingerprint.runtime;
    if (inst.source_sessions.length > 0) {
      frontmatter.source_session = inst.source_sessions[0]!.session_id;
    }
  }

  // Trial results summary
  const allTrials = candidate.instances.flatMap(i => i.trial_results);
  if (allTrials.length > 0) {
    frontmatter.trial_results = allTrials.map(t => ({
      trial_id: t.trial_id,
      candidate_id: t.candidate_id,
      completed_at: t.completed_at,
    }));
  }

  const yamlStr = YAML.stringify(frontmatter, { lineWidth: 120 });

  // Body: trigger + action + assertions
  const bodyParts: string[] = [
    `# ${s.problem_category}`,
    '',
    '## Trigger Conditions',
    '',
    s.trigger_conditions,
    '',
    '## Recommended Action',
    '',
    s.recommended_action,
  ];

  // Assertions from all instances
  const allAssertions = candidate.instances.flatMap(i => i.assertions);
  if (allAssertions.length > 0) {
    bodyParts.push('', '## Assertions', '');
    for (const a of allAssertions) {
      bodyParts.push(`- **${a.type}**: ${a.description}`);
    }
  }

  return `---\n${yamlStr}---\n\n${bodyParts.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

export function writeMirror(candidatesDir: string, candidate: Candidate): string {
  const target = mirrorPath(candidatesDir, candidate);
  const tmpPath = target + '.tmp';

  mkdirSync(dirname(target), { recursive: true });

  const content = renderMirror(candidate);
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, target);
  return target;
}

// ---------------------------------------------------------------------------
// Check if mirror is up-to-date
// ---------------------------------------------------------------------------

export function isMirrorCurrent(candidatesDir: string, candidate: Candidate): boolean {
  const target = mirrorPath(candidatesDir, candidate);
  if (!existsSync(target)) return false;
  const existing = readFileSync(target, 'utf-8');
  const expected = renderMirror(candidate);
  return existing === expected;
}

// ---------------------------------------------------------------------------
// Repair: scan all candidates, write missing/stale mirrors
// ---------------------------------------------------------------------------

export interface RepairResult {
  total: number;
  written: number;
  skipped: number;
  details: Array<{ id: string; action: 'written' | 'skipped' }>;
}

export function repairMirrors(
  candidatesDir: string,
  candidates: Candidate[],
  opts: { dryRun?: boolean } = {},
): RepairResult {
  const result: RepairResult = { total: candidates.length, written: 0, skipped: 0, details: [] };

  for (const c of candidates) {
    if (isMirrorCurrent(candidatesDir, c)) {
      result.skipped++;
      result.details.push({ id: c.candidate_id, action: 'skipped' });
    } else {
      if (!opts.dryRun) {
        writeMirror(candidatesDir, c);
      }
      result.written++;
      result.details.push({ id: c.candidate_id, action: 'written' });
    }
  }

  return result;
}
