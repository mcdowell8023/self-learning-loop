import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

import type { Candidate, CandidateState } from '../kernel/types.js';
import type { DroppedItem } from '../reflect/candidate-generator.js';

export interface ReflectionRun {
  generatedAt: string;
  eventsCollected: number;
  candidatesGenerated: number;
  candidatesDropped: number;
  durationMs: number;
  reasonsTriggered: string[];
  newCandidates: Candidate[];
  droppedItems: DroppedItem[];
  auditLogPath?: string;
  rawEventPath?: string;
}

export interface DailyReportData {
  date: string;
  reflectionRuns: ReflectionRun[];
  totalCandidates: number;
  candidatesByState: Record<string, number>;
  newCandidatesToday: Candidate[];
  staleBacklog: Candidate[];
  candidateSnapshot?: Candidate[];
  droppedSummary: Record<string, DroppedItem[]>;
}

export interface RunMeta {
  generatedAt: string;
  auditLogPath?: string;
  rawEventPath?: string;
}

export const DOMAIN_TITLE_MAP: Record<string, string> = {
  model_routing_failure: '模型路由故障识别',
  test_result_trust: '测试结果可信度',
  test_result_trust_and_environment_isolation: '测试结果可信度与环境隔离',
  documentation_sync_failure: '文档同步失败',
  environment_isolation: '环境隔离要求',
  cli_compatibility: 'CLI 兼容性',
  feishu_message_overflow: '飞书消息过载',
  tool_chain_validation: '工具链验证',
  release_pipeline: '发版流程',
  release_quality_assurance: '发版质量保障',
  schema_compatibility: 'Schema 兼容性',
  context_management: '上下文管理',
  progressive_defer_to_next_day: '渐进式推迟原则',
  credential_token_path_mismatch: '凭证路径不一致',
  unknown: '未分类候选',
};

export function shortId(id: string): string {
  return id.startsWith('sha256:') ? id.slice(7, 15) : id.slice(0, 8);
}

export function humanizeProblemCategory(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function titleForCandidate(candidate: Pick<Candidate, 'candidate_id' | 'strategy'>): string {
  const problemCategory = candidate.strategy.problem_category;
  if (DOMAIN_TITLE_MAP[problemCategory]) return DOMAIN_TITLE_MAP[problemCategory];
  if (problemCategory) return humanizeProblemCategory(problemCategory);
  return `候选 ${shortId(candidate.candidate_id)}`;
}

function ageDays(createdAt: string, date: string): number {
  const a = new Date(`${date}T00:00:00+08:00`).getTime();
  const b = new Date(createdAt).getTime();
  return Math.max(0, Math.floor((a - b) / 86400000));
}

function quoteBlock(text?: string): string {
  if (!text) return '> （无）';
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => `> ${line}`)
    .join('\n');
}

function renderCandidateCard(candidate: Candidate, index: number, date: string): string {
  const firstInstance = candidate.instances[0];
  const triggerSummary = candidate.strategy.trigger_event?.summary ?? candidate.strategy.summary ?? candidate.strategy.trigger_conditions;
  const assertions = firstInstance?.assertions ?? [];
  const assertionsBlock = assertions.length > 0
    ? assertions.map(assertion => `- \`${assertion.type}\`${assertion.description ? ` ${assertion.description}` : ''}${assertion.command ? `\n  - command: \`${assertion.command}\`` : ''}${typeof assertion.expected_exit_code === 'number' ? `\n  - expected_exit_code: ${assertion.expected_exit_code}` : ''}`).join('\n')
    : '- （无断言）';

  return [
    `### ${index}. ${titleForCandidate(candidate)} \`${candidate.strategy.problem_category}\``,
    '',
    `- **ID：** \`${candidate.candidate_id}\`（短：${shortId(candidate.candidate_id)}）`,
    `- **状态：** ${candidate.state}`,
    `- **创建时间：** ${candidate.created_at}`,
    `- **来源：** ${firstInstance?.source_sessions?.[0]?.session_id ?? 'unknown'}`,
    '',
    '**触发条件：**',
    quoteBlock(triggerSummary),
    '',
    '**建议行动：**',
    quoteBlock(candidate.strategy.recommended_action),
    '',
    '**断言：**',
    assertionsBlock,
    '',
    `📁 候选文件：\`learn/candidates/${date}/${candidate.candidate_id}-${candidate.strategy.problem_category}.md\``,
    '',
    '---',
  ].join('\n');
}

function renderDroppedSummary(droppedSummary: Record<string, DroppedItem[]>): string {
  const groups = Object.entries(droppedSummary).filter(([, items]) => items.length > 0);
  if (groups.length === 0) return '无丢弃候选。';

  const iconFor = (reason: string): string => ({
    duplicate: '🔁',
    low_signal: '📉',
    low_confidence: '📉',
    schema_invalid: '🧩',
    other: '⚠️',
  }[reason] ?? '⚠️');

  const titleFor = (reason: string): string => ({
    duplicate: '重复',
    low_signal: '信号太弱',
    low_confidence: '置信度不足',
    schema_invalid: 'Schema 无效',
    other: '其他',
  }[reason] ?? reason);

  return groups.map(([reason, items]) => [
    `### ${iconFor(reason)} ${titleFor(reason)} (${items.length})`,
    '',
    ...items.map(item => `- ${item.reason_detail ?? item.reason}${item.candidate_id_attempted ? `（attempted_id: ${shortId(item.candidate_id_attempted)}）` : ''}`),
    '',
  ].join('\n')).join('\n');
}

const STALE_DAYS_THRESHOLD = 4;
const SNAPSHOT_RECENT_LIMIT = 3;

/** 紧凑表格：标题 + 创建/龄期 合并列。已删除 ID、状态列。 */
function renderCompactCandidateTable(candidates: Candidate[], date: string): string {
  if (candidates.length === 0) return '无候选。';
  const rows = candidates.map(candidate => {
    const age = ageDays(candidate.created_at, date);
    const dateStr = candidate.created_at.slice(0, 10);
    return `| ${titleForCandidate(candidate)} | ${dateStr} (${age}d) |`;
  });
  return [
    '| 标题 | 创建于（龄期） |',
    '|------|----------------|',
    ...rows,
  ].join('\n');
}

/** 超期分组（旧版 stale section 入口）。保留全部超期项，按龄期 desc 排列。 */
function renderBacklogTable(candidates: Candidate[], date: string): string {
  if (candidates.length === 0) return '无候选。';
  const sorted = [...candidates].sort((a, b) => ageDays(b.created_at, date) - ageDays(a.created_at, date));
  return renderCompactCandidateTable(sorted, date);
}

/**
 * 候选库快照精简渲染（T-051）。
 * 输出结构：
 *   ⚠️ 超期 ≥ 4 天 (N)：完整表格
 *   🆕 最近 3 条：按 created_at desc
 *   📊 全量统计 + 提示
 */
function renderCandidateSnapshot(candidates: Candidate[], date: string, byState: Record<string, number>): string {
  if (candidates.length === 0) return '无候选。';

  const stale = candidates.filter(c => ageDays(c.created_at, date) >= STALE_DAYS_THRESHOLD);
  const fresh = [...candidates].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const recent = fresh.slice(0, SNAPSHOT_RECENT_LIMIT);

  const blocks: string[] = [];

  if (stale.length > 0) {
    blocks.push(`### ⚠️ 超期 ≥ ${STALE_DAYS_THRESHOLD} 天 (${stale.length})`);
    blocks.push('');
    blocks.push(renderCompactCandidateTable(
      [...stale].sort((a, b) => ageDays(b.created_at, date) - ageDays(a.created_at, date)),
      date,
    ));
    blocks.push('');
  }

  blocks.push(`### 🆕 最近 ${Math.min(SNAPSHOT_RECENT_LIMIT, recent.length)} 条（共 ${candidates.length} 条候选）`);
  blocks.push('');
  blocks.push(renderCompactCandidateTable(recent, date));
  blocks.push('');

  const stateSummary = Object.entries(byState)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${state} ${count}`)
    .join(' / ');
  blocks.push(`📊 候选库共 ${candidates.length} 条${stateSummary ? `（${stateSummary}）` : ''}。`);
  blocks.push('🔍 完整列表：openclaw-learn review list（或见 learn/candidates/）');

  return blocks.join('\n');
}

function renderHeader(data: DailyReportData, latestRun: ReflectionRun, reflectCount: number): string {
  const fm = {
    date: data.date,
    reflect_count: reflectCount,
    total_candidates: data.totalCandidates,
    candidates_by_state: data.candidatesByState,
    new_candidates_today: data.newCandidatesToday.length,
    stale_backlog: data.staleBacklog.length,
    generated_at: latestRun.generatedAt,
  };
  const snapshotCandidates = data.candidateSnapshot ?? [];

  return [
    '---',
    YAML.stringify(fm).trim(),
    '---',
    '',
    `# 学习闭环日报 · ${data.date}`,
    '',
    `> 生成时间：${latestRun.generatedAt}`,
    `> Reflect: events=${latestRun.eventsCollected} · 新增=${latestRun.candidatesGenerated} · 丢弃=${latestRun.candidatesDropped} · 耗时=${(latestRun.durationMs / 1000).toFixed(1)}s`,
    '',
    '## 📊 总览',
    '',
    `- **采集事件：** ${latestRun.eventsCollected}`,
    `- **新增候选：** ${latestRun.candidatesGenerated}`,
    `- **被丢弃：** ${latestRun.candidatesDropped}`,
    `- **候选库总数：** ${data.totalCandidates}（pending ${data.candidatesByState.pending ?? 0} / reviewing ${data.candidatesByState.reviewing ?? 0} / shadow ${data.candidatesByState.shadow ?? 0} / graduated ${data.candidatesByState.graduated ?? 0}）`,
    '',
    '## 🆕 今日新增候选',
    '',
    data.newCandidatesToday.length > 0
      ? data.newCandidatesToday.map((candidate, index) => renderCandidateCard(candidate, index + 1, data.date)).join('\n')
      : '今日无新增候选。',
    '',
    '## ⚠️ 被丢弃的候选',
    '',
    renderDroppedSummary(data.droppedSummary),
    '',
    '## ⏰ 超期未审（pending ≥ 4 天）',
    '',
    data.staleBacklog.length > 0
      ? renderBacklogTable(data.staleBacklog, data.date)
      : '无超期候选。',
    '',
    '## 📚 候选库快照',
    '',
    snapshotCandidates.length > 0 ? renderCandidateSnapshot(snapshotCandidates, data.date, data.candidatesByState) : '无候选。',
    '',
    '## 🎯 行动建议',
    '',
    '1. review 新候选（命令：`openclaw-learn review show <ID>`）',
    '2. 处理超期未审：`openclaw-learn review list --status pending`',
    '3. 查看完整候选：`ls ~/.openclaw/workspace/learn/candidates/`',
    '',
  ].join('\n');
}

export function renderRunSection(run: ReflectionRun, runNumber: number): string {
  return [
    `## Run #${runNumber} · ${run.generatedAt}`,
    '',
    `- events_collected: ${run.eventsCollected}`,
    `- candidates_generated: ${run.candidatesGenerated}`,
    `- candidates_dropped: ${run.candidatesDropped}`,
    `- duration_ms: ${run.durationMs}`,
    `- reasons_triggered: ${run.reasonsTriggered.length > 0 ? run.reasonsTriggered.join(', ') : 'manual'}`,
    `- audit_log: ${run.auditLogPath ?? 'learn/audit/<date>.jsonl'}`,
    `- raw_event: ${run.rawEventPath ?? 'learn/events/reflection-completed.json'}`,
    '',
  ].join('\n');
}

export function generateDailyReport(data: DailyReportData): string {
  const latestRun = data.reflectionRuns[data.reflectionRuns.length - 1];
  if (!latestRun) {
    throw new Error('generateDailyReport requires at least one reflection run');
  }

  const header = renderHeader(data, latestRun, data.reflectionRuns.length);
  const runSections = data.reflectionRuns.map((run, index) => renderRunSection(run, index + 1)).join('\n');

  return [
    header,
    '---',
    '',
    runSections,
    '🤖 Generated by self-learning-loop v1.1.0-alpha.5',
    `📝 Audit log: \`${latestRun.auditLogPath ?? 'learn/audit/reflect-unknown.jsonl'}\``,
    `📁 Raw event: \`${latestRun.rawEventPath ?? 'learn/events/reflection-completed.json'}\``,
    '',
  ].join('\n');
}

/**
 * Extract historical Run #N sections from an existing daily report as opaque
 * text blocks. We do NOT parse business data out of the markdown — we only
 * preserve previously rendered run-history text so the new report keeps a
 * continuous changelog. Embedded footer lines (🤖 / 📝 / 📁) are stripped so
 * the footer only appears once in the regenerated document.
 */
function extractHistoricalRunSections(existing: string): { sections: string[]; nextRunNumber: number } {
  const firstRunIndex = existing.indexOf('## Run #');
  if (firstRunIndex < 0) return { sections: [], nextRunNumber: 1 };

  const tailText = existing.slice(firstRunIndex);
  // Split on each `## Run #` boundary while preserving the heading.
  const rawBlocks = tailText.split(/(?=^## Run #)/m).map(block => block.trim()).filter(Boolean);

  const cleanedSections: string[] = [];
  let maxRunNumber = 0;
  for (const block of rawBlocks) {
    const headerMatch = block.match(/^## Run #(\d+)/);
    if (!headerMatch) continue;
    const runNumber = Number(headerMatch[1]);
    if (Number.isFinite(runNumber)) maxRunNumber = Math.max(maxRunNumber, runNumber);

    // Strip footer lines that may have been appended inside this section by
    // older write paths (one per previous run). Keep everything else verbatim.
    const cleaned = block
      .split('\n')
      .filter(line => !/^🤖 Generated by self-learning-loop/.test(line))
      .filter(line => !/^📝 Audit log:/.test(line))
      .filter(line => !/^📁 Raw event:/.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (cleaned) cleanedSections.push(cleaned);
  }

  return { sections: cleanedSections, nextRunNumber: maxRunNumber + 1 };
}

export async function writeOrAppendDailyReport(
  workspaceDir: string,
  reportData: DailyReportData,
  runMeta: RunMeta,
): Promise<string> {
  const reportsDir = join(workspaceDir, 'learn', 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = join(reportsDir, `${reportData.date}-daily.md`);
  const latestRun = reportData.reflectionRuns[reportData.reflectionRuns.length - 1];
  if (!latestRun) throw new Error('writeOrAppendDailyReport requires at least one reflection run');

  if (!existsSync(reportPath)) {
    writeFileSync(reportPath, generateDailyReport(reportData), 'utf-8');
    return reportPath;
  }

  // Append branch: rebuild the entire document from `reportData` (the only
  // authoritative business-data source) plus opaque historical run-section
  // text blocks lifted from the previous file. Header / frontmatter /
  // snapshot / 行动建议 are ALWAYS re-rendered from the latest reportData.
  const existing = readFileSync(reportPath, 'utf-8');
  const { sections: historicalRunSections, nextRunNumber } = extractHistoricalRunSections(existing);
  const totalRunCount = nextRunNumber; // historical runs + current = nextRunNumber

  const latestRunWithMeta: ReflectionRun = {
    ...latestRun,
    generatedAt: runMeta.generatedAt,
    auditLogPath: runMeta.auditLogPath ?? latestRun.auditLogPath,
    rawEventPath: runMeta.rawEventPath ?? latestRun.rawEventPath,
  };
  const newSection = renderRunSection(latestRunWithMeta, totalRunCount);
  const header = renderHeader(reportData, latestRunWithMeta, totalRunCount);

  const allRunSections = [...historicalRunSections, newSection.trim()].join('\n\n');
  const footer = [
    '🤖 Generated by self-learning-loop v1.1.0-alpha.5',
    `📝 Audit log: \`${runMeta.auditLogPath ?? latestRun.auditLogPath ?? 'learn/audit/reflect-unknown.jsonl'}\``,
    `📁 Raw event: \`${runMeta.rawEventPath ?? latestRun.rawEventPath ?? 'learn/events/reflection-completed.json'}\``,
  ].join('\n');

  const updated = `${header}---\n\n${allRunSections}\n\n${footer}\n`;

  writeFileSync(reportPath, updated, 'utf-8');
  return reportPath;
}
