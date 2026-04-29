import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateDailyReport, humanizeProblemCategory, renderRunSection, shortId, titleForCandidate, writeOrAppendDailyReport, type DailyReportData, type ReflectionRun } from './daily-report-generator.js';
import type { Candidate } from '../kernel/types.js';
import type { DroppedItem } from '../reflect/candidate-generator.js';

function makeCandidate(id: string, problem = 'model_routing_failure', state: Candidate['state'] = 'pending', createdAt = '2026-04-27T08:00:00.000Z'): Candidate {
  return {
    candidate_id: id,
    state,
    created_at: createdAt,
    updated_at: createdAt,
    dormant_reason: null,
    strategy: {
      strategy_id: id,
      problem_category: problem,
      trigger_conditions: '触发条件示例',
      recommended_action: '建议行动示例',
      summary: '摘要示例',
      trigger_event: { summary: '触发事件摘要' },
      scope: 'general',
      created_at: createdAt,
      instance_ids: [`inst-${id}`],
    },
    instances: [{
      instance_id: `inst-${id}`,
      strategy_id: id,
      diff_summary: 'diff',
      files_touched: ['AGENTS.md'],
      env_fingerprint: { runtime: 'openclaw', platform: 'linux', arch: 'x64' },
      source_sessions: [{ session_id: 'cli-reflect-1', runtime: 'openclaw', timestamp: createdAt }],
      assertions: [{ type: 'command_exit_code', description: 'should pass', expected_exit_code: 0 }],
      trial_results: [],
      created_at: createdAt,
    }],
  };
}

function makeRun(overrides: Partial<ReflectionRun> = {}): ReflectionRun {
  return {
    generatedAt: '2026-04-27T16:30:00+08:00',
    eventsCollected: 22,
    candidatesGenerated: 2,
    candidatesDropped: 3,
    durationMs: 5200,
    reasonsTriggered: ['manual'],
    newCandidates: [makeCandidate('sha256:68b21d20a87ab861')],
    droppedItems: [{ reason: 'duplicate', reason_code: 'duplicate', reason_detail: '重复项', raw: {} }],
    auditLogPath: 'learn/audit/reflect-2026-04-27.jsonl',
    rawEventPath: 'learn/events/reflection-completed.json',
    ...overrides,
  };
}

function makeData(overrides: Partial<DailyReportData> = {}): DailyReportData {
  const run = makeRun();
  return {
    date: '2026-04-27',
    reflectionRuns: [run],
    totalCandidates: 3,
    candidatesByState: { pending: 2, reviewing: 0, shadow: 0, graduated: 1 },
    newCandidatesToday: run.newCandidates,
    staleBacklog: [makeCandidate('sha256:abcddddd11112222', 'release_pipeline', 'pending', '2026-04-20T08:00:00.000Z')],
    droppedSummary: { duplicate: run.droppedItems },
    ...overrides,
  };
}

describe('daily-report-generator', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'daily-report-'));
    mkdirSync(join(workspace, 'learn'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('generates a readable markdown report', () => {
    const report = generateDailyReport(makeData());
    expect(report).toContain('# 学习闭环日报 · 2026-04-27');
    expect(report).toContain('## 📊 总览');
    expect(report).toContain('## 🆕 今日新增候选');
    expect(report).toContain('## Run #1 · 2026-04-27T16:30:00+08:00');
  });

  it('includes yaml frontmatter', () => {
    const report = generateDailyReport(makeData());
    expect(report.startsWith('---\n')).toBe(true);
    expect(report).toContain('reflect_count: 1');
    expect(report).toContain('total_candidates: 3');
  });

  it('renders known domain titles in chinese', () => {
    expect(titleForCandidate(makeCandidate('sha256:68b21d20a87ab861'))).toBe('模型路由故障识别');
  });

  it('humanizes unknown problem categories', () => {
    expect(humanizeProblemCategory('future_new_problem')).toBe('Future New Problem');
  });

  it('shortens sha256 ids', () => {
    expect(shortId('sha256:68b21d20a87ab861')).toBe('68b21d20');
  });

  it('handles empty new candidates and dropped summary', () => {
    const report = generateDailyReport(makeData({ newCandidatesToday: [], droppedSummary: {}, reflectionRuns: [makeRun({ newCandidates: [], droppedItems: [] })] }));
    expect(report).toContain('今日无新增候选。');
    expect(report).toContain('无丢弃候选。');
  });

  it('renders dropped groups', () => {
    const dropped: DroppedItem[] = [
      { reason: 'duplicate', reason_code: 'duplicate', reason_detail: '重复候选', raw: {} },
      { reason: 'low_signal', reason_code: 'low_signal', reason_detail: '信号太弱', raw: {} },
    ];
    const report = generateDailyReport(makeData({ droppedSummary: { duplicate: [dropped[0]!], low_signal: [dropped[1]!] }, reflectionRuns: [makeRun({ droppedItems: dropped, candidatesDropped: 2 })] }));
    expect(report).toContain('### 🔁 重复 (1)');
    expect(report).toContain('### 📉 信号太弱 (1)');
  });

  it('supports large candidate snapshots', () => {
    const candidates = Array.from({ length: 12 }, (_, i) => makeCandidate(`sha256:id${String(i).padStart(6, '0')}`, `cat_${i}`));
    const report = generateDailyReport(makeData({ newCandidatesToday: candidates, totalCandidates: 12, staleBacklog: [], candidateSnapshot: candidates }));
    expect(report).toContain('| ID | 标题 | 状态 | 创建于 | 龄期 |');
    expect(report).toContain('Cat 0');
  });

  it('writes a new report file', async () => {
    const reportPath = await writeOrAppendDailyReport(workspace, makeData(), { generatedAt: '2026-04-27T16:30:00+08:00' });
    const content = readFileSync(reportPath, 'utf-8');
    expect(content).toContain('学习闭环日报');
  });

  it('appends run sections for same-day multiple reflects', async () => {
    const data = makeData();
    const reportPath = await writeOrAppendDailyReport(workspace, data, { generatedAt: '2026-04-27T16:30:00+08:00' });
    await writeOrAppendDailyReport(workspace, makeData({ reflectionRuns: [makeRun({ generatedAt: '2026-04-27T18:00:00+08:00', eventsCollected: 40 })], totalCandidates: 4 }), { generatedAt: '2026-04-27T18:00:00+08:00' });
    const content = readFileSync(reportPath, 'utf-8');
    expect(content).toContain('## Run #1 · 2026-04-27T16:30:00+08:00');
    expect(content).toContain('## Run #2 · 2026-04-27T18:00:00+08:00');
    expect(content).toContain('reflect_count: 2');
  });

  it('refreshes header / frontmatter / snapshot to latest aggregate on every same-day reflect', async () => {
    // Run #1
    const data1: DailyReportData = {
      date: '2026-04-27',
      reflectionRuns: [makeRun({ generatedAt: '2026-04-27T10:00:00+08:00', eventsCollected: 10, candidatesGenerated: 1, candidatesDropped: 0, newCandidates: [makeCandidate('sha256:run1aaaa11111111')], droppedItems: [] })],
      totalCandidates: 1,
      candidatesByState: { pending: 1, reviewing: 0, shadow: 0, graduated: 0 },
      newCandidatesToday: [makeCandidate('sha256:run1aaaa11111111')],
      staleBacklog: [],
      candidateSnapshot: [makeCandidate('sha256:run1aaaa11111111')],
      droppedSummary: {},
    };
    const reportPath = await writeOrAppendDailyReport(workspace, data1, { generatedAt: '2026-04-27T10:00:00+08:00', auditLogPath: 'learn/audit/reflect-2026-04-27.jsonl', rawEventPath: 'learn/events/reflection-completed.json' });

    // Run #2 — totals + snapshot grow; header must reflect Run #2 totals
    const snapshotRun2 = [makeCandidate('sha256:run1aaaa11111111'), makeCandidate('sha256:run2bbbb22222222', 'release_pipeline')];
    const data2: DailyReportData = {
      date: '2026-04-27',
      reflectionRuns: [makeRun({ generatedAt: '2026-04-27T18:00:00+08:00', eventsCollected: 99, candidatesGenerated: 1, candidatesDropped: 2, newCandidates: [makeCandidate('sha256:run2bbbb22222222', 'release_pipeline')], droppedItems: [] })],
      totalCandidates: 6,
      candidatesByState: { pending: 5, reviewing: 0, shadow: 0, graduated: 1 },
      newCandidatesToday: [makeCandidate('sha256:run2bbbb22222222', 'release_pipeline')],
      staleBacklog: [],
      candidateSnapshot: snapshotRun2,
      droppedSummary: {},
    };
    await writeOrAppendDailyReport(workspace, data2, { generatedAt: '2026-04-27T18:00:00+08:00', auditLogPath: 'learn/audit/reflect-2026-04-27.jsonl', rawEventPath: 'learn/events/reflection-completed.json' });

    // Run #3 — totals grow further; header must NOT remain on Run #2
    const snapshotRun3 = [...snapshotRun2, makeCandidate('sha256:run3cccc33333333', 'cli_compatibility')];
    const data3: DailyReportData = {
      date: '2026-04-27',
      reflectionRuns: [makeRun({ generatedAt: '2026-04-27T22:00:00+08:00', eventsCollected: 200, candidatesGenerated: 0, candidatesDropped: 1, newCandidates: [], droppedItems: [] })],
      totalCandidates: 7,
      candidatesByState: { pending: 6, reviewing: 0, shadow: 0, graduated: 1 },
      newCandidatesToday: [],
      staleBacklog: [],
      candidateSnapshot: snapshotRun3,
      droppedSummary: {},
    };
    await writeOrAppendDailyReport(workspace, data3, { generatedAt: '2026-04-27T22:00:00+08:00', auditLogPath: 'learn/audit/reflect-2026-04-27.jsonl', rawEventPath: 'learn/events/reflection-completed.json' });

    const content = readFileSync(reportPath, 'utf-8');

    // Frontmatter — 5 required fields reflect Run #3 aggregate
    expect(content).toMatch(/^---\n[\s\S]+?\n---/);
    expect(content).toContain('reflect_count: 3');
    expect(content).toContain('total_candidates: 7');
    expect(content).toContain('new_candidates_today: 0');
    expect(content).toContain('stale_backlog: 0');
    expect(content).toContain('generated_at: 2026-04-27T22:00:00+08:00');

    // Header summary line reflects latest run, NOT Run #2 numbers
    expect(content).toContain('生成时间：2026-04-27T22:00:00+08:00');
    expect(content).toContain('Reflect: events=200 · 新增=0 · 丢弃=1');
    expect(content).not.toMatch(/生成时间：2026-04-27T18:00:00\+08:00/);
    expect(content).not.toMatch(/Reflect: events=99/);
    expect(content).not.toMatch(/Reflect: events=10/);

    // Overview block reflects latest aggregate counts
    expect(content).toContain('采集事件：** 200');
    expect(content).toContain('候选库总数：** 7');

    // Snapshot table reflects the newest cumulative snapshot
    expect(content).toContain('run3ccc');
    expect(content).toContain('run2bbb');
    expect(content).toContain('run1aaa');

    // Action recommendations block is present (latest render)
    expect(content).toContain('## 🎯 行动建议');
    expect(content).toContain('openclaw-learn review show');

    // All three run sections preserved with continuous numbering
    expect(content).toContain('## Run #1 · 2026-04-27T10:00:00+08:00');
    expect(content).toContain('## Run #2 · 2026-04-27T18:00:00+08:00');
    expect(content).toContain('## Run #3 · 2026-04-27T22:00:00+08:00');
    const runHeaders = Array.from(content.matchAll(/^## Run #(\d+)/gm)).map(m => Number(m[1]));
    expect(runHeaders).toEqual([1, 2, 3]);

    // Footer must appear exactly once (no per-run accumulation)
    const footerMatches = content.match(/🤖 Generated by self-learning-loop/g) ?? [];
    expect(footerMatches).toHaveLength(1);
    const auditFooterMatches = content.match(/📝 Audit log:/g) ?? [];
    expect(auditFooterMatches).toHaveLength(1);
  });

  it('renders run section metadata', () => {
    const section = renderRunSection(makeRun(), 3);
    expect(section).toContain('## Run #3 · 2026-04-27T16:30:00+08:00');
    expect(section).toContain('events_collected: 22');
  });
});
