// src/reflect/trigger.ts
//
// Reflection Trigger（T-P1a-005）
// 对齐 v5.0.3 §5.3.2（触发时机）+ 任务描述中的 §7.3 触发条件。
//
// Phase 1a 采用 keyword 匹配 + 简单计数，不上 NLP。
//
// 触发条件（任一命中即触发反思）：
//   1. 错误事件：type=error / tool_result 含 stderr-like 关键字
//   2. 工具异常：tool_call 后紧跟 tool_result + 失败关键字
//   3. 用户纠正：user_message 含否定关键字（"错了"/"不对"/"改改"/"redo"...）
//   4. 重复工作：相同 tool_call 名称在时间窗口内重复 ≥ 阈值
//   5. 时间窗口：距上次反思 ≥ 6 小时（兜底）

import type { SessionEvent } from './reflection-prompt.js';

// ---------------------------------------------------------------------------
// 触发器配置
// ---------------------------------------------------------------------------

export interface TriggerConfig {
  /** 距上次反思的最小间隔（毫秒），默认 6h */
  timeWindowMs: number;
  /** 重复 tool_call 检测窗口（毫秒），默认 6h */
  repeatWindowMs: number;
  /** 重复 tool_call 阈值（同名调用 ≥ N 次视为重复），默认 3 */
  repeatThreshold: number;
  /** 错误关键字（大小写不敏感，contains 匹配） */
  errorKeywords: string[];
  /** 用户纠正关键字（大小写不敏感，contains 匹配） */
  correctionKeywords: string[];
  /** tool_result 失败关键字 */
  toolFailureKeywords: string[];
}

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  timeWindowMs: 6 * 60 * 60 * 1000,   // 6 小时
  repeatWindowMs: 6 * 60 * 60 * 1000, // 6 小时
  repeatThreshold: 3,
  errorKeywords: [
    'error',
    'exception',
    'traceback',
    'failed',
    'failure',
    'stderr',
    'panic',
    'fatal',
    'segfault',
    '错误',
    '异常',
    '失败',
  ],
  correctionKeywords: [
    '错了',
    '不对',
    '不是这样',
    '改改',
    '重新做',
    '重做',
    '别这样',
    '不要这样',
    "that's wrong",
    'thats wrong',
    'incorrect',
    'redo',
    'try again',
    'not what i asked',
    'not what i wanted',
  ],
  toolFailureKeywords: [
    'exit code 1',
    'exit code: 1',
    'non-zero exit',
    'command failed',
    'command not found',
    'permission denied',
    'no such file',
    'timeout',
  ],
};

// ---------------------------------------------------------------------------
// 触发结果
// ---------------------------------------------------------------------------

export type TriggerReason =
  | 'error_event'
  | 'tool_failure'
  | 'user_correction'
  | 'repeat_tool_call'
  | 'time_window'
  | 'manual';

export interface TriggerDecision {
  shouldReflect: boolean;
  reasons: TriggerReason[];
  /** 每个原因对应的匹配细节（便于审计） */
  details: Array<{ reason: TriggerReason; evidence: string }>;
}

export interface EvaluateInput {
  events: SessionEvent[];
  /** 上次反思时间（ISO 字符串或 Date），首次可省略 */
  lastReflectAt?: string | Date | null;
  /** 当前时间（默认 now），测试注入 */
  now?: Date;
  /** 强制触发（手动/CLI） */
  manual?: boolean;
  config?: Partial<TriggerConfig>;
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

export function evaluateTrigger(input: EvaluateInput): TriggerDecision {
  const cfg: TriggerConfig = { ...DEFAULT_TRIGGER_CONFIG, ...input.config };
  const now = input.now ?? new Date();
  const reasons: TriggerReason[] = [];
  const details: Array<{ reason: TriggerReason; evidence: string }> = [];

  // 手动触发直接返回
  if (input.manual) {
    reasons.push('manual');
    details.push({ reason: 'manual', evidence: 'manual=true' });
    return { shouldReflect: true, reasons, details };
  }

  const events = input.events ?? [];

  // 1) 错误事件
  for (const e of events) {
    if (e.type === 'error') {
      reasons.push('error_event');
      details.push({
        reason: 'error_event',
        evidence: `event.type=error @ ${fmtTs(e.timestamp)}: ${trim(e.content)}`,
      });
      break;
    }
    if (containsAny(e.content, cfg.errorKeywords)) {
      reasons.push('error_event');
      details.push({
        reason: 'error_event',
        evidence: `keyword hit in ${e.type} @ ${fmtTs(e.timestamp)}: ${trim(e.content)}`,
      });
      break;
    }
  }

  // 2) 工具异常：tool_result 且含失败关键字
  for (const e of events) {
    if (e.type === 'tool_result' && containsAny(e.content, cfg.toolFailureKeywords)) {
      reasons.push('tool_failure');
      details.push({
        reason: 'tool_failure',
        evidence: `tool_result failure @ ${fmtTs(e.timestamp)}: ${trim(e.content)}`,
      });
      break;
    }
  }

  // 3) 用户纠正
  for (const e of events) {
    if (e.type === 'user_message' && containsAny(e.content, cfg.correctionKeywords)) {
      reasons.push('user_correction');
      details.push({
        reason: 'user_correction',
        evidence: `user_message correction @ ${fmtTs(e.timestamp)}: ${trim(e.content)}`,
      });
      break;
    }
  }

  // 4) 重复 tool_call：以 metadata.tool_name 或 content 首行为 key
  const repeatHit = detectRepeat(events, cfg, now);
  if (repeatHit) {
    reasons.push('repeat_tool_call');
    details.push({ reason: 'repeat_tool_call', evidence: repeatHit });
  }

  // 5) 时间窗口兜底
  if (input.lastReflectAt != null) {
    const last =
      input.lastReflectAt instanceof Date
        ? input.lastReflectAt
        : new Date(input.lastReflectAt);
    if (!Number.isNaN(last.getTime())) {
      const gap = now.getTime() - last.getTime();
      if (gap >= cfg.timeWindowMs) {
        reasons.push('time_window');
        details.push({
          reason: 'time_window',
          evidence: `gap=${Math.round(gap / 60000)}min ≥ ${Math.round(cfg.timeWindowMs / 60000)}min`,
        });
      }
    }
  } else {
    // 首次：只要有事件就兜底触发一次
    if (events.length > 0) {
      reasons.push('time_window');
      details.push({ reason: 'time_window', evidence: 'first-run bootstrap' });
    }
  }

  return {
    shouldReflect: reasons.length > 0,
    reasons,
    details,
  };
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function containsAny(text: string, keywords: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

function detectRepeat(
  events: SessionEvent[],
  cfg: TriggerConfig,
  now: Date,
): string | null {
  const counts = new Map<string, number>();
  const cutoff = now.getTime() - cfg.repeatWindowMs;

  for (const e of events) {
    if (e.type !== 'tool_call') continue;
    const ts =
      e.timestamp instanceof Date ? e.timestamp.getTime() : new Date(e.timestamp).getTime();
    if (Number.isNaN(ts) || ts < cutoff) continue;

    const key = toolKey(e);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if ((counts.get(key) ?? 0) >= cfg.repeatThreshold) {
      return `tool_call "${key}" repeated ${counts.get(key)}× within ${Math.round(
        cfg.repeatWindowMs / 60000,
      )}min`;
    }
  }
  return null;
}

function toolKey(e: SessionEvent): string {
  const meta = e.metadata ?? {};
  const name =
    (meta.tool_name as string | undefined) ??
    (meta.name as string | undefined) ??
    e.content.split('\n')[0]?.slice(0, 80) ??
    'unknown';
  return String(name);
}

function trim(s: string, n = 120): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function fmtTs(t: Date | string): string {
  if (t instanceof Date) return t.toISOString();
  return String(t);
}
