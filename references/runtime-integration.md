# Runtime Integration Reference — self-learning-loop v1.1

> **架构基线：** learning-loop-design-v5.0.5.md  
> **本文件描述四 Runtime 适配详解、三级注册发现、GenericAdapter YAML Mapping DSL、能力差异和跨 Runtime 去重策略。**

---

## §R1 四 Runtime 对照表

继承 v1.1 §4.2 和 v5.0.5 §4.2 完整对照。

| 维度 | OpenClaw | Claude Code | OpenCode | Codex |
|------|----------|-------------|----------|-------|
| **Adapter** | OpenClawAdapter（内置） | ClaudeCodeAdapter（内置） | OpencodeAdapter（内置） | GenericAdapter + YAML DSL |
| **Adapter 状态** | ✅ 已实装 | ⚠️ 待实测（R2） | ⚠️ Phase 2 | Phase 2（T-SLL-012） |
| **Skill 存放路径** | `~/.openclaw/workspace/skills/self-learning-loop/` | `~/.claude/skills/self-learning-loop/` | `~/.local/share/opencode/skills/self-learning-loop/` | `~/.codex/skills/self-learning-loop/` |
| **Session 数据源** | `~/.openclaw/agents/*/sessions/*.jsonl`（v5.0.4） | `~/.claude/projects/*/sessions/*.jsonl` ⚠️ | SQLite `~/.local/share/opencode/opencode.db`（R1） | 取决于 YAML mapping |
| **Session 格式** | JSONL，envelope `{type:"message", message:{role, content:[parts]}}` | JSONL，类似 OpenClaw 但字段名不同 | SQLite 数据库（messages 表） | 取决于 YAML mapping |
| **Workspace 检测** | `$OPENCLAW_WORKSPACE` → `~/.openclaw/workspace/` | `$CLAUDE_CODE_WORKSPACE` → `pwd` | `$OPENCODE_WORKSPACE` → `pwd` | `$CODEX_WORKSPACE` → `pwd` |
| **增量策略** | byte offset（v5.0.5 §4.4.1） | byte offset | message.id（非 byte offset） | 取决于 YAML mapping |
| **日记默认路径** | `$WS/memory/YYYY-MM-DD.md` | `$WS/memory/YYYY-MM-DD.md` | `$WS/memory/YYYY-MM-DD.md` | `$WS/memory/YYYY-MM-DD.md` |
| **工具能力** | exec / read / write 全有 | exec / read / write 全有 | exec / read / write 全有 | 全有（沙盒内） |
| **cron 支持** | `openclaw cron add` 原生 | system crontab | system crontab | system crontab |
| **触发方式** | SKILL.md 自动加载 + cron | SKILL.md 自动加载 | SKILL.md 自动加载 | SKILL.md 自动加载 |

### OpenClawAdapter 详情（v5.0.5 §4.2.1，v5.0.4 修订）

| 维度 | 说明 |
|------|------|
| **Session 路径（主）** | `~/.openclaw/agents/*/sessions/*.jsonl`（每个 agent 独立 sessions 子目录） |
| **Session 路径（legacy）** | `~/.openclaw/sessions/*.jsonl`（旧版布局，auto-detect fallback，命中时 warn） |
| **detect()** | glob 主路径，非空即命中；否则扫 legacy |
| **sessionId** | 主路径：`{agentName}/{basename}`；legacy：`basename` |
| **extractEvents()** | JSONL 行 → parts 拆分（text → assistant_message, tool_use → tool_call, tool_result, thinking） |
| **增量** | byte offset，持久化到 `collect-state.json` |
| **v5.0.5 改进** | 路径从 config 读取（不再硬编码），支持 `agents_root` / `legacy_session_dir` 配置 |

### ClaudeCodeAdapter 详情（⚠️ 待实测 — R2）

| 维度 | 说明 |
|------|------|
| **Session 路径假设** | `~/.claude/projects/*/sessions/*.jsonl` — **未实测** |
| **detect()** | 检查 `~/.claude/` → fallback `~/.claude-code/`、`~/.config/claude/` |
| **首次 detect 失败** | dry-run 扫描多路径 + 引导用户配置 `adapters[name=claude-code].projects_root` |
| **字段映射** | `role:"human"` → `user_message`，`ts` (epoch ms) → `new Date(ts)` |

### OpencodeAdapter 详情（R1 — SQLite 重写）

| 维度 | 说明 |
|------|------|
| **数据源** | SQLite `~/.local/share/opencode/opencode.db` |
| **SQL 驱动** | `better-sqlite3` |
| **listNewSessions()** | `SELECT DISTINCT session_id FROM messages WHERE id > ?` |
| **extractEvents()** | `SELECT * FROM messages WHERE session_id = ? ORDER BY created_at` |
| **增量策略** | 记录最后 `message.id`（非 byte offset） |
| **ACP 可选** | `acp.enabled: true` 时通过 `opencode acp --port 4096` 实时接收事件 |

### Codex（GenericAdapter + YAML DSL）

通过 `configs/codex-mapping.yaml` 配置接入，无需编写代码。见 §R3。

---

## §R2 三级注册发现

继承 v5.0.5 §4.5.2，Adapter 支持三级注册发现。

### 发现顺序（local → global → npm）

| 级别 | 路径 | 说明 |
|------|------|------|
| **local** | `$WORKSPACE/learn/config/adapters/*.yaml` 或 `$WORKSPACE/.self-learning-loop/adapters/` | 本地 GenericAdapter YAML 配置或自定义 Adapter |
| **global** | `~/.openclaw-learn/adapters/` | 全局安装的 Adapter 包 |
| **npm** | `node_modules/@openclaw-learn/adapter-*` | npm 安装的 Adapter 包 |

**同名覆盖规则：** local 优先覆盖 global，global 优先覆盖 npm。

### Adapter 管理命令

```bash
# 安装第三方 npm Adapter
openclaw-learn adapter install @openclaw-learn/adapter-aider

# 添加 GenericAdapter YAML 配置
openclaw-learn adapter add ./aider.yaml

# 验证配置（dry-run）
openclaw-learn adapter test aider --dry-run

# 列出已注册 Adapter
openclaw-learn adapter list
# ┌──────────────┬─────────┬──────────┬────────┐
# │ ID           │ Version │ Source   │ Status │
# ├──────────────┼─────────┼──────────┼────────┤
# │ openclaw     │ 1.2.0   │ builtin  │ active │
# │ claude-code  │ 1.0.0   │ builtin  │ active │
# │ opencode     │ 1.0.0   │ builtin  │ active │
# │ codex        │ 0.1.0   │ yaml     │ active │
# │ aider        │ 1.0.0   │ npm      │ active │
# └──────────────┴─────────┴──────────┴────────┘
```

### npm 命名规范

**包名：** `@openclaw-learn/adapter-<runtime>`

示例：
- `@openclaw-learn/adapter-aider`
- `@openclaw-learn/adapter-cursor`
- `@openclaw-learn/adapter-windsurf`

### SessionEvent 扩展协议（v5.0.5 §4.5.3）

| 场景 | 处理方式 |
|------|----------|
| 已知标准类型（user_message / assistant_message / tool_call / tool_result / error / system） | 正常处理 |
| Adapter 通过 `extendedEventTypes` 声明的类型 | 识别即透传，Generator 可读取 |
| 未声明的未知类型 | 降级为 `system`，记审计 warning |

---

## §R3 GenericAdapter YAML Mapping DSL

继承 v5.0.5 §4.3，为长尾 Runtime 提供零代码的 YAML 配置接入。

### 完整 YAML 示例

```yaml
# configs/codex-mapping.yaml
adapter:
  id: codex
  display_name: "Codex CLI"
  version: "0.1.0"

detect:
  env_var: CODEX_WORKSPACE
  fallback_paths:
    - ~/.codex/
    - ~/.config/codex/

sessions:
  glob: "sessions/*.jsonl"
  id_extract: "filename"
  timestamp_field: "created_at"

events:
  format: "jsonl"                      # jsonl | json | csv
  type_mapping:
    human: "user_message"
    assistant: "assistant_message"
    tool_use: "tool_call"
    tool_result: "tool_result"
  content_path: "content"
  timestamp_path: "timestamp"

env_fingerprint:
  runtime: "codex"
  platform: auto
  arch: auto

extended_event_types:
  - "codex_sandbox_exec"
```

### 另一个示例：Aider

```yaml
# adapters/aider.yaml
adapter:
  id: aider
  display_name: "Aider"
  version: "1.0.0"

detect:
  env_var: AIDER_HOME
  fallback_paths:
    - ~/.aider/

sessions:
  glob: "~/.aider/history/*.jsonl"
  id_extract: "filename"
  timestamp_field: "created_at"

events:
  format: jsonl
  type_mapping:
    user: "user_message"
    assistant: "assistant_message"
    function: "tool_call"
    function_result: "tool_result"
    error: "error"
    "*": "system"                      # 兜底
  content_path: "message"
  fallback_content_path: "data.text"   # 二级嵌套
  timestamp_path: "created_at"
  timestamp_format: "iso8601"          # iso8601 | epoch_ms | epoch_s

metadata:
  passthrough: true
  include: ["model", "token_count", "tool_name"]

env_fingerprint:
  runtime: "aider"
  platform: auto
  arch: auto

extended_event_types:
  - "aider_edit"
  - "aider_commit"
```

### 字段映射语法（v5.0.5 §4.3.2）

| 语法 | 说明 | 示例 |
|------|------|------|
| **直接字段名** | JSON 一级字段 | `field: "role"` → `obj.role` |
| **点号导航** | 嵌套字段 | `field: "data.text"` → `obj.data.text` |
| **jsonpath** | 复杂路径（`$` 开头） | `field: "$.messages[0].content"` |
| **regex 提取** | 正则匹配 | `field: "raw"`, `regex: "^(\\w+):"`, `group: 1` |
| **常量** | 固定值 | `const: "custom-agent"` |
| **fallback 链** | 主字段缺失时备选 | `field: "text"`, `fallback: "message.content"` |
| **values 枚举** | 值映射 | `values: { "human": "user_message" }` |
| **format 时间** | 时间解析格式 | `format: "epoch_ms"` |

### GenericAdapter 注册

```bash
# 添加 YAML 配置
openclaw-learn adapter add ./codex-mapping.yaml

# 验证（dry-run）
openclaw-learn adapter test codex --dry-run

# 列出
openclaw-learn adapter list
```

---

## §R4 Runtime 能力差异

基于 `openclaw-runtime-capability-map.md` §2-§3 的关键发现。

### 能力对照表

| 能力 | OpenClaw | Claude Code | OpenCode | Codex |
|------|----------|-------------|----------|-------|
| **session.onEnd hook** | ❌ 不可用 | ❌ | ❌ | ❌ |
| **injectContext** | ❌ 不可用 | ❌ | ❌ | ❌ |
| **transcript 读取** | ✅ JSONL | ✅ JSONL | ✅ SQLite | ✅ 取决于格式 |
| **session 元数据** | ✅ 从 transcript | ✅ | ✅ | ✅ |
| **subagent spawn** | ✅ `sessions_spawn` | ❌ | ❌ | ❌ |
| **exec** | ✅ | ✅ | ✅ | ✅（沙盒内） |
| **cron 原生支持** | ✅ `openclaw cron add` | ❌ 需 system crontab | ❌ 需 system crontab | ❌ 需 system crontab |
| **网络访问** | ✅ | ✅ | ✅ | ⚠️ 沙盒限制 |

### 关键适配策略

#### 采集用 cron 非 hook

**问题：** `session.onEnd` hook 在所有 Runtime 都不可用。

**策略：** 采集统一用 cron 主动轮询（默认 30 分钟间隔），不依赖任何 hook。

```
cron tick → 各 Adapter.listNewSessions(since) → extractEvents → dedup → reflect
```

#### Shadow Validation 用 sessions_spawn

**问题：** `injectContext` 在 OpenClaw 中不可用，无法直接向 session 注入上下文。

**策略：** Shadow validation 通过 `sessions_spawn` 在 task 字符串头部预置候选规则。

```typescript
// Shadow trial 注入候选规则
const trialTask = `
## 实验规则（自动注入，请遵循）
${candidate.recommended_action}

## 原始任务
${originalTask}
`;

sessions_spawn({
  task: trialTask,
  model: "claude-haiku-4.5",  // 用轻量模型做 trial
});
```

**限制：** 仅 OpenClaw 支持 `sessions_spawn`。其他 Runtime 的 shadow trial 需要：
- Claude Code：用户手动在新会话中测试
- OpenCode：用户手动测试
- Codex：通过 Codex sandbox exec 模拟

#### Cron 注册差异

| Runtime | 注册方式 | 示例 |
|---------|---------|------|
| **OpenClaw** | 原生 cron API | `openclaw cron add --schedule "30 22 * * *" --command "bash daily-reflect.sh"` |
| **Claude Code** | system crontab | `echo "30 22 * * * bash /path/to/daily-reflect.sh" \| crontab -` |
| **OpenCode** | system crontab | 同上 |
| **Codex** | system crontab | 同上（注意沙盒限制） |

`setup.sh` 在安装时提示用户手动注册 cron（不自动注册，避免意外行为）。

---

## §R5 各 Runtime Cron 注册方式

### OpenClaw（推荐方式）

```bash
# 自动注册
openclaw cron add \
  --name "self-learning-loop-daily" \
  --schedule "30 22 * * *" \
  --command "bash ~/.openclaw/workspace/skills/self-learning-loop/scripts/daily-reflect.sh"

# 查看
openclaw cron list

# 删除
openclaw cron remove self-learning-loop-daily
```

### Claude Code / OpenCode / Codex（system crontab）

```bash
# 编辑 crontab
crontab -e

# 添加行：
30 22 * * * bash ~/.agents/skills/self-learning-loop/scripts/daily-reflect.sh >> ~/.self-learning-loop/logs/cron.log 2>&1
```

### daily-reflect.sh 通用化要点

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${SCRIPT_DIR}/.self-learning-loop/logs"
mkdir -p "$LOG_DIR"

# 1. 检查 daily_token_budget
BUDGET_CHECK=$(node "${SCRIPT_DIR}/bin/openclaw-learn" budget-check 2>&1) || {
  echo "[$(date -Iseconds)] Budget exceeded, skipping" >> "${LOG_DIR}/daily.log"
  exit 0
}

# 2. 执行反思
echo "[$(date -Iseconds)] Starting daily reflect" >> "${LOG_DIR}/daily.log"
node "${SCRIPT_DIR}/bin/openclaw-learn" reflect >> "${LOG_DIR}/daily.log" 2>&1

# 3. 记录结果
echo "[$(date -Iseconds)] Daily reflect completed" >> "${LOG_DIR}/daily.log"
```

---

## §R6 跨 Runtime 去重

继承 v5.0.5 §4.4.2 完整去重算法。

### 两层去重架构

| 层级 | 去重对象 | 算法 | v5.0.5 引用 |
|------|---------|------|-------------|
| **事件级** | SessionEvent | contentHash（SHA256 前 32 字符）+ 30s 窗口 + preferRicherEnv | §4.4.2 |
| **候选级** | Strategy | Content-addressable ID + Review Gate D3 相似度检查 | §5.1.4, §5.4 |
| **Trial 级** | TrialResult | candidate_id + runtime + session_id 三元组 | v5.0.1 B4 |

### 事件级去重流程

```
多 Adapter 并行采集
  ↓ merge 所有 SessionEvent
  ↓ computeContentHash(event) → SHA256(type:content).slice(0,32)
  ↓ 30s 窗口内同 hash → 重复
  ↓ 重复时：preferRicherEnv() → 保留 env 更丰富的
  ↓ 去重后的 SessionEvent[] → Candidate Generator
```

### 跨 Runtime 典型场景

**场景：** 用户同时用 OpenClaw 和 Claude Code，两个 Runtime 看到同一个文件修改：

```
OpenClaw session: "修改了 AGENTS.md 添加清理规则"
Claude Code session: "edited AGENTS.md to add cleanup rule"
```

**处理：**
1. 事件级：内容不同（中英文），contentHash 不同，不去重
2. 候选级：两个 Runtime 分别产出候选，如果 Strategy（problem_category + trigger_conditions + recommended_action）归一化后相同 → Content-addressable ID 相同 → 合并为 Instance
3. 如果 Strategy 相似度 > 0.9 但不完全相同 → Review Gate D3 合并为已有 Strategy 的新 Instance

### preferRicherEnv 算法

```typescript
function envRichnessScore(env: EnvFingerprint): number {
  let score = 0;
  if (env.runtime) score += 1;
  if (env.platform) score += 1;
  if (env.arch) score += 1;
  if (env.model) score += 1;
  if (env.nodeVersion) score += 1;
  if (env.extensions) score += Object.keys(env.extensions).length;
  return score;
}

// 同 hash + 30s 内 → 保留 env 更丰富的
// tie-breaker: 时间戳更新的
```

### 配置

```yaml
collect:
  dedup:
    mode: content_hash_window
    window_ms: 30000
    prefer_richer_env: true
    trial_dedup_key: "candidate_id+runtime+session_id"
```
