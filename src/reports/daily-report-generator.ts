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
  reporter_wrapper_atomicity: 'Reporter 包装器原子性',
  subagent_output_format_exactness: '子代理输出格式精确性',
  subagent_output_format_enforcement: '子代理输出格式强制',
  cron_safety_pause_compliance: 'Cron 安全暂停合规',
  heartbeat_rule_adherence: '心跳规则遵守',
  heartbeat_gate_misuse: '心跳门控误用',
  cron_heartbeat_write_noise: 'Cron 心跳写入噪音',
  cron_heartbeat_no_reply_logic: 'Cron 心跳 NO_REPLY 逻辑',
  memory_file_timestamp_parsing: '记忆文件时间戳解析',
  stdout_dependency_breakage_detection: '标准输出依赖断裂检测',
  stdout_stderr_visibility: '标准输出/错误可见性',
  cron_subagent_no_stdout_detection: 'Cron 子代理无输出检测',
  report_render_staleness: '报告渲染陈旧性',
  heartbeat_no_watermark_noise: '心跳水印噪音控制',
  diary_pollution_prevention: '日记污染防护',
  markdown_output_staleness: 'Markdown 输出陈旧性',
  single_source_of_truth_violation: '单一事实来源违反',
  pause_on_blocking_clear_instruction: '阻塞时暂停明确指令',
  avoid_heartbeat_noise_messaging: '避免心跳噪音消息',
  cli_flag_gating: 'CLI 标志门控',
  gitignore_build_output_verification: 'Gitignore 构建产出验证',
  diary_heartbeat_multi_channel_sanity_check: '日记心跳多通道完整性检查',
  git_ignored_artifacts_tracked_check: 'Git 忽略产物跟踪检查',
  feature_flag_gating_for_mock_path: '功能标志门控（Mock 路径）',
  tool_schema_validation_fallback_edit_payload: '工具 Schema 验证降级',
  git_ignore_build_artifacts: 'Git 忽略构建产物',
  staged_change_minimize_and_verify: '暂存变更最小化与验证',
  diary_heartbeat_channel_scan: '日记心跳通道扫描',
  'heartbeat-noise_control': '心跳噪音控制',
  'cron-block-fallback': 'Cron 阻塞降级',
  'evidence-based-aggregation': '基于证据的聚合',
  heartbeat_gating: '心跳门控',
  multi_channel_causal_inference_guard: '多通道因果推断守卫',
  command_availability_fallback: '命令可用性降级',
  async_command_management: '异步命令管理',
  time_window_dedup_logic: '时间窗口去重逻辑',
  tool_command_missing: '工具命令缺失',
  json_jq_schema_mismatch: 'JSON/JQ Schema 不匹配',
  async_long_running_management: '异步长任务管理',
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

export const STATE_LABEL: Record<string, string> = {
  pending: '待审', reviewing: '审核中', shadow: '影子跟踪',
  validating: '验证中', dormant: '休眠', graduated: '已毕业', rejected: '已退役',
};

export function titleForCandidate(candidate: Pick<Candidate, 'candidate_id' | 'strategy'> & { title?: string }): string {
  if (candidate.title) return candidate.title;
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

function truncateLine(text: string | undefined, maxLen = 80): string {
  if (!text) return '（无）';
  const single = text.replace(/\n/g, ' ').trim();
  return single.length <= maxLen ? single : `${single.slice(0, maxLen - 1)}…`;
}

function renderCandidateCard(candidate: Candidate, index: number, _date: string): string {
  const triggerSummary = candidate.strategy.trigger_event?.summary ?? candidate.strategy.summary ?? candidate.strategy.trigger_conditions;
  const createdDate = candidate.created_at.slice(0, 10);
  const stateLabel = STATE_LABEL[candidate.state] ?? candidate.state;

  const lines = [
    `### ${index}. ${titleForCandidate(candidate)}`,
    `📅 ${createdDate} · ${stateLabel}`,
  ];
  if (triggerSummary) lines.push(`**问题：** ${truncateLine(triggerSummary)}`);
  if (candidate.strategy.recommended_action) lines.push(`**规则：** ${truncateLine(candidate.strategy.recommended_action)}`);
  lines.push('');
  return lines.join('\n');
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

const STATE_GROUP_ICON: Record<string, string> = {
  pending: '🟡待审',
  validating: '🔵验证中',
  dormant: '💤休眠',
  graduated: '✅已毕业',
  rejected: '❌已退役',
  reviewing: '🔵审核中',
  shadow: '🔵影子跟踪',
};

/**
 * 候选库快照按 state 分组渲染（T-059）。
 */
function renderCandidateSnapshot(candidates: Candidate[], date: string, _byState: Record<string, number>): string {
  if (candidates.length === 0) return '无候选。';

  // Group by state
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const arr = groups.get(c.state) ?? [];
    arr.push(c);
    groups.set(c.state, arr);
  }

  const stateOrder = ['pending', 'reviewing', 'validating', 'shadow', 'dormant', 'graduated', 'rejected'];
  const blocks: string[] = [];

  for (const state of stateOrder) {
    const group = groups.get(state);
    if (!group || group.length === 0) continue;
    const icon = STATE_GROUP_ICON[state] ?? state;
    const warning = state === 'pending' ? ' ⚠️' : '';
    blocks.push(`### ${icon} (${group.length})${warning}`);
    blocks.push('');
    blocks.push(renderCompactCandidateTable(
      [...group].sort((a, b) => ageDays(b.created_at, date) - ageDays(a.created_at, date)),
      date,
    ));
    blocks.push('');
  }

  blocks.push(`📊 候选库共 ${candidates.length} 条。`);
  blocks.push('🔍 完整列表：openclaw-learn review list（或见 learn/candidates/）');

  return blocks.join('\n');
}

function renderActionRecommendations(data: DailyReportData): string {
  // Pick top 3 actionable items: stale pending ≥5d first, then new with specific triggers
  interface ActionItem { id: string; title: string; hint: string; priority: number }
  const items: ActionItem[] = [];

  for (const c of data.staleBacklog) {
    if (c.state !== 'pending') continue;
    const age = ageDays(c.created_at, data.date);
    if (age >= 5) {
      items.push({ id: shortId(c.candidate_id), title: titleForCandidate(c), hint: `超期 ${age} 天，建议尽快决策`, priority: age });
    }
  }

  for (const c of data.newCandidatesToday) {
    const trigger = c.strategy.trigger_event?.summary ?? c.strategy.trigger_conditions ?? '';
    const specificity = trigger.length;
    items.push({ id: shortId(c.candidate_id), title: titleForCandidate(c), hint: '今日新增，值得审阅', priority: specificity > 20 ? 50 : 10 });
  }

  items.sort((a, b) => b.priority - a.priority);
  const top = items.slice(0, 3);

  if (top.length === 0) {
    return '今日无需紧急决策。\n\n💡 完整候选清单见 `openclaw-learn review list`';
  }

  const lines = top.map(item => `→ ${item.id} ${item.title} · ${item.hint}`);
  lines.push('');
  lines.push('💡 完整候选清单见 `openclaw-learn review list`');
  return lines.join('\n');
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

  // Only pending stale
  const pendingStale = data.staleBacklog.filter(c => c.state === 'pending');

  // 总览区动态遍历 candidatesByState + 中文 label
  const stateSummary = Object.entries(data.candidatesByState)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${STATE_LABEL[state] ?? state} ${count}`)
    .join(' / ');

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
    '## 🎯 行动建议',
    '',
    renderActionRecommendations(data),
    '',
    '## 🆕 今日新增候选',
    '',
    data.newCandidatesToday.length > 0
      ? data.newCandidatesToday.map((candidate, index) => renderCandidateCard(candidate, index + 1, data.date)).join('\n')
      : '今日无新增候选。',
    '',
    '## 📊 总览',
    '',
    `- **采集事件：** ${latestRun.eventsCollected}`,
    `- **新增候选：** ${latestRun.candidatesGenerated}`,
    `- **被丢弃：** ${latestRun.candidatesDropped}`,
    `- **候选库总数：** ${data.totalCandidates}（${stateSummary}）`,
    '',
    '## ⚠️ 被丢弃的候选',
    '',
    renderDroppedSummary(data.droppedSummary),
    '',
    `<details><summary>📚 候选库快照（共 ${snapshotCandidates.length} 条）</summary>`,
    '',
    snapshotCandidates.length > 0 ? renderCandidateSnapshot(snapshotCandidates, data.date, data.candidatesByState) : '无候选。',
    '',
    '</details>',
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
