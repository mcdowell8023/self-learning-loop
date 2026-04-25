// src/reflect/reflection-prompt.ts
//
// Reflection Prompt 模板（T-P1a-005）
// 严格对齐 v5.0.3 §5.3.1 骨架。
//
// 占位符：
//   {session_events}     — 格式化后的会话记录
//   {existing_strategies} — 当前活跃 Strategy 的摘要（用于去重提示）
//   {env_fingerprint}    — 运行环境指纹
//   {problem_categories} — 已知分类标签集合（提示 LLM 尽量复用）

import type { EnvFingerprint } from '../kernel/types.js';

// ---------------------------------------------------------------------------
// SessionEvent 最小类型（与 v5.0.3 §4.1.3 对齐）
//
// 注意：T-P1a-002（Adapter）未落盘时，本模块独立维护最小接口；
// T-P1a-002 交付后将切换为 `import type { SessionEvent } from '../collection/types.js'`。
// ---------------------------------------------------------------------------

export interface SessionEvent {
  type:
    | 'user_message'
    | 'assistant_message'
    | 'tool_call'
    | 'tool_result'
    | 'error'
    | 'system'
    | string;
  timestamp: Date | string;
  content: string;
  metadata: Record<string, unknown>;
  contentHash?: string;
  raw?: unknown;
}

// ---------------------------------------------------------------------------
// Prompt 构建参数
// ---------------------------------------------------------------------------

export interface BuildPromptParams {
  events: SessionEvent[];
  env: EnvFingerprint;
  /** 既有 Strategy 摘要（"problem_category: recommended_action" 简写） */
  existingStrategies?: string[];
  /** 已知 problem_category 集合（提示 LLM 复用分类） */
  problemCategories?: string[];
  /** 自定义模板（覆盖默认 §5.3.1 骨架） */
  template?: string;
  /** 每个事件 content 的截断长度（防 prompt 过长），默认 500 */
  eventContentTruncate?: number;
  /** 最多纳入多少条事件，默认 50 */
  maxEvents?: number;
}

// ---------------------------------------------------------------------------
// 默认模板（严格对齐 v5.0.3 §5.3.1）
// ---------------------------------------------------------------------------

export const DEFAULT_REFLECT_TEMPLATE = `
你是一个 AI Agent 行为分析师。分析以下工作会话记录，提取可复用的经验规则。

## 会话记录

{session_events}

## 环境信息

Runtime: {runtime}
Platform: {platform} / {arch}
Model: {model}

{env_extensions}

## 已有 Strategy（避免重复提取）

{existing_strategies}

## 已知 problem_category（尽量复用）

{problem_categories}

## 任务

1. 识别会话中的**错误、低效、或成功模式**
2. 对每个发现，提取为结构化候选规则
3. 每次反思最多产出 **0-3 条**候选（宁精勿滥）
4. **如果会话信息量不足以提炼可验证规则，返回 \`{"candidates": []}\`。这是完全合法的输出，不要返回 error 对象。**

## 流程模式提取

如发现可复用的工作流模式（例如：审查 → 修订 → 复审循环、模型故障转移与降级链、grep/sed 验证闭环、子代理派发与结果校验等），即使缺少具体文件路径，也可生成 confidence ≤ 0.7 的"流程类"候选。这类候选可在后续工具执行阶段通过实际验证来陈化。

## 输出格式（严格 JSON Schema）

**必须**返回一个 JSON 对象，格式为 \`{"candidates": [...]}\`。candidates 数组可以为空。绝不返回 error 对象。

candidates 数组中每个元素的字段定义：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| problem_category | string | ✅ | 分类标签，尽量复用已知分类 |
| trigger_conditions | string | ✅ | 什么条件下应触发此规则 |
| recommended_action | string | ✅ | 推荐采取的行动 |
| scope | string | ✅ | 枚举：\`"general"\` / \`"skill"\` / \`"tool:<name>"\` / \`"role:<name>"\` |
| diff_summary | string | 可选 | 这次具体做了什么修复/改进 |
| files_touched | string[] | 可选 | 涉及的文件路径，无具体文件可省略或传 \`[]\` |
| assertions | object[] | 可选 | 验证断言列表，每项含 type(必填)、description、command、expected_exit_code |
| confidence | number | 可选 | 0.0-1.0，有文件/命令证据 ≥ 0.7；流程类 0.3-0.7；默认 0.5 |
| rationale | string | 可选 | 为什么这是一条好规则 |
| tags | string[] | 可选 | 标签，如 \`["model-routing", "reliability"]\` |

assertions[].type 允许值：\`"file_exists"\` / \`"regex_match"\` / \`"command_exit_code"\` / 其他自定义字符串。

## 示例

**示例 1：基于具体文件的规则**
\`\`\`json
{"candidates": [
  {
    "problem_category": "model_routing_failure",
    "trigger_conditions": "子代理使用 gemini-3.1-pro-preview 执行架构类任务时超时或输出不足",
    "recommended_action": "架构类任务禁用 gemini-3.1-pro-preview，降级链为 opus-4.6 → opus-4.7 → gpt-5.4",
    "scope": "role:architect",
    "diff_summary": "图灵模型从 gemini-3.1-pro-preview 切换为 opus-4.6，超时问题解决",
    "files_touched": ["TOOLS.md"],
    "assertions": [
      {
        "type": "regex_match",
        "description": "TOOLS.md 图灵模型配置不含 gemini",
        "command": "grep -c 'gemini' TOOLS.md | grep -v '#'",
        "expected_exit_code": 1
      }
    ],
    "confidence": 0.85,
    "rationale": "gemini-3.1-pro 在长文档输出上连续失败，已有多次超时记录",
    "tags": ["model-routing", "reliability"]
  }
]}
\`\`\`

**示例 2：流程类规则（无具体文件）**
\`\`\`json
{"candidates": [
  {
    "problem_category": "changelog_overreport",
    "trigger_conditions": "子代理修订方案后声明 CHANGELOG 已全部闭合",
    "recommended_action": "修订交付必须附 grep 自查证据，主控必抽查关键字残留",
    "scope": "general",
    "assertions": [
      {
        "type": "command_exit_code",
        "description": "修订后对旧关键字的 grep 应返回空（exit 1）"
      }
    ],
    "confidence": 0.6,
    "rationale": "连续两轮 CHANGELOG 过报，引入自查机制后一次过",
    "tags": ["review-process", "trust"]
  }
]}
\`\`\`

**示例 3：信息量不足**
\`\`\`json
{"candidates": []}
\`\`\`

## 约束

- 只提取**可验证的**规则（必须能写 assertion；流程类规则的 assertion 可以是描述性的）
- 不提取过于宽泛的规则（"写好代码"不算）
- 不提取一次性的修复（只在特定文件/场景有效的不算通用规则）
- scope 必须标注准确：影响所有角色用 general，仅影响特定工具用 tool:<name>
- **再次强调：输出必须是 \`{"candidates": [...]}\`。信息不足就返回 \`{"candidates": []}\`，绝不返回 error 对象。**
`.trim();

// ---------------------------------------------------------------------------
// 格式化辅助
// ---------------------------------------------------------------------------

export function formatEvents(
  events: SessionEvent[],
  opts: { truncate?: number; maxEvents?: number } = {},
): string {
  const truncate = opts.truncate ?? 500;
  const maxEvents = opts.maxEvents ?? 50;

  const slice = events.slice(-maxEvents); // 取最近 N 条
  if (slice.length === 0) return '(无事件)';

  return slice
    .map((e, idx) => {
      const ts =
        e.timestamp instanceof Date
          ? e.timestamp.toISOString()
          : String(e.timestamp);
      const content =
        e.content.length > truncate
          ? e.content.slice(0, truncate) + `…[+${e.content.length - truncate} chars]`
          : e.content;
      const meta =
        e.metadata && Object.keys(e.metadata).length > 0
          ? ` [meta=${safeMeta(e.metadata)}]`
          : '';
      return `### Event #${idx + 1} · ${e.type} · ${ts}${meta}\n${content}`;
    })
    .join('\n\n');
}

function safeMeta(m: Record<string, unknown>): string {
  try {
    return JSON.stringify(m);
  } catch {
    return '[unserializable]';
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function buildReflectPrompt(params: BuildPromptParams): string {
  const template = params.template ?? DEFAULT_REFLECT_TEMPLATE;
  const env = params.env;

  const envExtensions =
    env.extensions && Object.keys(env.extensions).length > 0
      ? 'Extensions: ' + safeMeta(env.extensions as Record<string, unknown>)
      : '';

  const existing =
    params.existingStrategies && params.existingStrategies.length > 0
      ? params.existingStrategies.map((s) => `- ${s}`).join('\n')
      : '(无)';

  const categories =
    params.problemCategories && params.problemCategories.length > 0
      ? params.problemCategories.join(', ')
      : '(无，可自由创建)';

  const eventsText = formatEvents(params.events, {
    truncate: params.eventContentTruncate,
    maxEvents: params.maxEvents,
  });

  // 占位符替换（顺序无关，全局替换）
  const replacements: Record<string, string> = {
    '{session_events}': eventsText,
    '{existing_strategies}': existing,
    '{problem_categories}': categories,
    '{env_fingerprint}': safeMeta(env as unknown as Record<string, unknown>),
    '{runtime}': env.runtime,
    '{platform}': env.platform,
    '{arch}': env.arch,
    '{model}': env.model ?? 'unknown',
    '{env_extensions}': envExtensions,
  };

  let out = template;
  for (const [k, v] of Object.entries(replacements)) {
    out = out.split(k).join(v);
  }
  return out;
}
