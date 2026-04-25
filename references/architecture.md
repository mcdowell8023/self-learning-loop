# Architecture Reference — self-learning-loop v1.1

> **架构基线：** learning-loop-design-v5.0.5.md  
> **本文件提供 SKILL.md L3 层深度架构参考，覆盖分层架构、数据模型、状态机、Review Gate、毕业路由和去重算法。**

---

## §A1 分层架构总览

继承 v5.0.5 §3.1 分层架构，学习闭环由五层组成：

```
┌─────────────────────────────────────────────────────────────────┐
│                       Outbound（对外层）                          │
│  ┌────────────┐  ┌──────────────┐  ┌───────┐  ┌─────────────┐  │
│  │ EvoMap     │  │ Parliament   │  │  CLI  │  │ REST API    │  │
│  │ Bridge     │  │ Hook         │  │       │  │ (Phase 3)   │  │
│  └─────┬──────┘  └──────┬───────┘  └───┬───┘  └──────┬──────┘  │
├────────┴────────────────┴───────────────┴─────────────┴─────────┤
│                       Decision（决策层）                          │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
│  │ Four-Layer     │  │ Conflict        │  │ Override         │  │
│  │ Evaluator      │  │ Cluster Manager │  │ CLI              │  │
│  │ (L1/L2/L3/L4) │  │                 │  │                  │  │
│  └───────┬────────┘  └────────┬────────┘  └────────┬─────────┘  │
├──────────┴─────────────────────┴────────────────────┴───────────┤
│                       Kernel（学习内核）                          │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  │
│  │ Candidate  │  │ Assertion  │  │ Shadow     │  │Graduation │  │
│  │ Generator  │  │ Engine     │  │ Runner     │  │ Executor  │  │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬─────┘  │
├────────┴────────────────┴───────────────┴───────────────┴───────┤
│                       Collection（采集层）                        │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ OpenClaw     │  │ Claude Code  │  │ opencode / Generic    │  │
│  │ Adapter      │  │ Adapter      │  │ Adapter               │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘  │
├─────────┴──────────────────┴──────────────────────┴─────────────┤
│                       Storage（存储层）                           │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  SQLite WAL（主存）+ 文件镜像（人类可读）+ JSONL（审计日志）   │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 各层职责

| 层 | 职责 | 关键模块 | v5.0.5 章节 |
|----|------|---------|-------------|
| **Collection** | 从各 Runtime session 中提取标准化事件流 | RuntimeAdapter, Dedup | v5.0.5 §4 |
| **Kernel** | 候选生成、审查、陈化观察、毕业执行 | Generator, Assertion, Shadow, Graduation | v5.0.5 §5 |
| **Decision** | 四层短路判定、冲突仲裁、人工 Override | Evaluator, Cluster, Override CLI | v5.0.5 §6-§8 |
| **Outbound** | CLI 交互、EvoMap Bridge、Parliament Hook | CLI, Bridge, Hook | v5.0.5 §7, §10 |
| **Storage** | SQLite WAL 主存 + 文件镜像 + JSONL 审计 | candidates.db, candidates/, audit/ | v5.0.5 §5.1.6 |

### 数据流概览

继承 v5.0.5 §3.2：

```
Session Transcript（任意 Runtime）
         │
         ▼
  RuntimeAdapter → 标准化 SessionEvent[]
         │
         ▼
  Dedup（contentHash + 30s 窗口，v5.0.5 §4.4.2）
         │
         ▼
  Candidate Generator（LLM 反思，0-3 条候选）
         │
         ▼
  Review Gate（四维审查，v5.0.5 §5.4）
         │
         ▼
  Shadow Runner（陈化期被动观察）
         │
         ▼
  Four-Layer Evaluator（L1/L2 硬闸门 + L3/L4 软加分）
         │
    ┌────┴─────┐
    │ PASS     │ FAIL → retired
    ▼          │ INCONCLUSIVE → dormant
  Graduation   │
  Executor     │
    │          │
    ▼          │
  写入 AGENTS.md / TOOLS.md / Skill 包
```

### 模块清单（继承 v5.0.5 §3.3）

| # | 模块 | Phase | 说明 |
|---|------|-------|------|
| 1 | RuntimeAdapter | P0/1 | 采集层接口 + 三个内置 adapter + GenericAdapter |
| 2 | Candidate Generator | P0/1 | LLM 反思产出 Strategy + Instance |
| 3 | Candidate Store | P0/1 | SQLite WAL 主存 + Content-addressable ID + 8 态状态机 |
| 4 | Assertion Engine | P0/1 | 断言定义 + 执行 + 三重安全加固 |
| 5 | Four-Layer Evaluator | P0/1 | L1/L2 硬闸门 + L3/L4 辅助 |
| 6 | Shadow Runner | P0/1 | 陈化期被动观察 + 采样偏置防护 |
| 7 | Conflict Cluster | P1/1 | 冲突检测 + A-B 仲裁 4 步算法 |
| 8 | Override CLI | P0/1 | 独立通用人工干预（与 Parliament 解耦） |
| 9 | Graduation Executor | P1/1-3 | 毕业路由 + 标记块 / Symlink 注入 |
| 10 | EvoMap Bridge | P2/2 | 可选出站/入站（Phase 2+） |
| 11 | Parliament Hook | P2/2-3 | 可选外部决策服务（Phase 2+） |
| 12 | Audit Logger | P0/1 | 全生命周期 JSONL 审计 |
| 13 | State Machine | P0/1 | 8 态状态流转引擎 |
| 14 | Config Manager | P0/1 | 配置加载 + 热更新 + 双缓冲 |
| 15 | Reflect Cron | P0/1 | 定时触发 + 事件驱动混合 |

---

## §A2 RuntimeAdapter 接口

逐字继承 v5.0.5 §4.1.1-§4.1.4 完整 TypeScript schema。

### §A2.1 核心接口（v5.0.5 §4.1.1）

```typescript
/**
 * RuntimeAdapter — 从特定 Runtime 的会话记录中提取标准化事件。
 * 每个 Runtime 实现一个 Adapter。所有方法必须处理 I/O 异常并抛出 AdapterError。
 */
export interface RuntimeAdapter {
  /** Adapter 唯一标识（必填） */
  readonly id: string;  // e.g. "openclaw" | "claude-code" | "opencode" | "generic"

  /** 人类可读名称（必填） */
  readonly displayName: string;

  /** Adapter 版本（必填，semver） */
  readonly version: string;

  /** 扩展事件类型声明（可选，Adapter 扩展点） */
  readonly extendedEventTypes?: string[];

  /** 检测该 Adapter 是否适用当前环境（必填） */
  detect(): Promise<boolean>;

  /** 列出自上次采集以来的新 session 文件（必填） */
  listNewSessions(since: Date): Promise<SessionRef[]>;

  /** 从单个 session 文件中提取标准化事件流（必填） */
  extractEvents(ref: SessionRef): AsyncIterable<SessionEvent>;

  /** 环境指纹（必填） */
  getEnvFingerprint(): Promise<EnvFingerprint>;

  /** 健康检查（可选，Adapter 扩展点） */
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;

  /** 清理资源（可选，Adapter 扩展点） */
  dispose?(): Promise<void>;
}
```

### §A2.2 SessionRef Schema（v5.0.5 §4.1.2）

```typescript
export interface SessionRef {
  /** 文件绝对路径（必填） */
  path: string;

  /** Runtime 标识，与 Adapter.id 一致（必填） */
  runtime: string;

  /** Session 唯一 ID（必填，由 Adapter 从文件名或内容提取） */
  sessionId: string;

  /** Session 开始时间（必填） */
  startedAt: Date;

  /** 文件字节大小（必填，用于增量采集） */
  byteSize: number;

  /** 上次采集的字节偏移量（Adapter 扩展点，用于增量读取） */
  lastOffset?: number;

  /** 附加元数据（Adapter 扩展点） */
  metadata?: Record<string, unknown>;
}
```

**必填字段：** `path`, `runtime`, `sessionId`, `startedAt`, `byteSize`  
**Adapter 扩展点：** `lastOffset`, `metadata`

### §A2.3 SessionEvent Schema（v5.0.5 §4.1.3）

```typescript
export interface SessionEvent {
  /** 事件类型（必填） */
  type: "user_message" | "assistant_message" | "tool_call"
      | "tool_result" | "error" | "system" | string;

  /** 事件时间戳（必填） */
  timestamp: Date;

  /** 事件内容文本（必填） */
  content: string;

  /** 结构化元数据（必填，至少为空对象） */
  metadata: Record<string, unknown>;

  /** 内容哈希，用于去重（由采集层自动计算，Adapter 无需填写） */
  contentHash?: string;

  /** 原始事件（可选，保留用于 debug，Adapter 扩展点） */
  raw?: unknown;
}
```

**标准事件类型：** `user_message`, `assistant_message`, `tool_call`, `tool_result`, `error`, `system`  
**扩展事件类型：** Adapter 可通过 `extendedEventTypes` 声明自定义类型，未声明的未知类型降级为 `system`。

### §A2.4 EnvFingerprint Schema（v5.0.5 §4.1.4）

```typescript
export interface EnvFingerprint {
  /** Runtime 标识（必填） */
  runtime: string;

  /** Runtime 版本（可选，Adapter 扩展点） */
  runtimeVersion?: string;

  /** 操作系统平台（必填） */
  platform: "linux" | "darwin" | "win32";

  /** CPU 架构（必填） */
  arch: "x64" | "arm64";

  /** 使用的模型（可选，Adapter 扩展点） */
  model?: string;

  /** Node.js 版本（可选，Adapter 扩展点） */
  nodeVersion?: string;

  /** 开放扩展字段（Adapter 扩展点，v5.0.1 修复：从 index signature 改为显式 extensions 字段） */
  extensions?: Record<string, unknown>;
}
```

**必填字段：** `runtime`, `platform`, `arch`  
**Adapter 扩展点：** `runtimeVersion`, `model`, `nodeVersion`, `extensions`

### §A2.5 字段分类总结（v5.0.5 §4.1）

| 接口 | 必填字段 | Adapter 扩展点 |
|------|---------|---------------|
| **RuntimeAdapter** | id, displayName, version, detect, listNewSessions, extractEvents, getEnvFingerprint | extendedEventTypes, healthCheck, dispose |
| **SessionRef** | path, runtime, sessionId, startedAt, byteSize | lastOffset, metadata |
| **SessionEvent** | type, timestamp, content, metadata | contentHash (自动), raw |
| **EnvFingerprint** | runtime, platform, arch | runtimeVersion, model, nodeVersion, extensions |

---

## §A3 Strategy + Instance 双层模型

继承 v5.0.5 §5.1 完整双层设计。

### 设计原理

借鉴 EvoMap 的 Gene + Capsule 双层分离思想：

- **Strategy（策略模板）：** 描述"遇到什么情况该怎么做"，是可复用的经验规则模板
- **Instance（具体实例）：** 策略在某次具体场景中的应用记录，包含 diff、环境、assertion 结果

同一个 Strategy 可以有多个 Instance（不同场景下的验证记录），实现经验的跨场景积累和跨 Runtime 验证。

### Strategy Schema（v5.0.5 §5.1.2）

```typescript
export interface Strategy {
  /** Content-addressable ID: SHA256(problem_category + trigger_conditions + recommended_action) */
  strategy_id: string;

  /** 问题分类（必填），如 "timeout_handling" / "file_cleanup" / "api_error_recovery" */
  problem_category: string;

  /** 触发条件（必填）：什么情况下应该应用这条策略 */
  trigger_conditions: string;

  /** 推荐行动（必填）：具体应该怎么做 */
  recommended_action: string;

  /** 适用范围（必填） */
  scope: "general" | `tool:${string}` | `role:${string}` | "skill";

  /** 策略标签（可选） */
  tags?: string[];

  /** 创建时间 */
  created_at: string;

  /** 关联 Instance ID 列表 */
  instance_ids: string[];
}
```

**scope 标注规则（v5.0.5 §5.3.4）：**

| scope 值 | 判断标准 | 示例 |
|----------|---------|------|
| `general` | 影响所有角色、所有项目 | "临时文件必须清理" |
| `tool:<name>` | 仅影响特定工具使用方式 | `tool:chrome-cdp` |
| `role:<name>` | 仅影响特定角色行为 | `role:鲁班` |
| `skill` | 可封装为独立 Skill | "视频总结标准流程" |

### Instance Schema（v5.0.5 §5.1.3）

```typescript
export interface Instance {
  /** Content-addressable ID: SHA256(strategy_id + diff_summary + env_fingerprint.runtime) */
  instance_id: string;

  /** 所属 Strategy ID（必填） */
  strategy_id: string;

  /** Diff 摘要（必填）：这次修复具体做了什么 */
  diff_summary: string;

  /** 涉及的文件列表（必填） */
  files_touched: string[];

  /** 环境指纹（必填） */
  env_fingerprint: EnvFingerprint;

  /** 来源 session 列表（必填） */
  source_sessions: Array<{
    session_id: string;
    runtime: string;
    timestamp: string;
  }>;

  /** 关联的 assertion 定义（必填） */
  assertions: AssertionSpec[];

  /** Shadow trial 结果列表 */
  trial_results: TrialResult[];

  /** 创建时间 */
  created_at: string;
}
```

### TrialResult Schema（v5.0.5 §5.5.1）

```typescript
export interface TrialResult {
  trial_id: string;
  candidate_id: string;
  session_id: string;
  runtime: string;
  started_at: string;
  completed_at: string;
  assertions: Array<{
    type: string;
    status: "pass" | "fail" | "timeout" | "error" | "skipped";
    duration_ms: number;
    detail?: string;
  }>;
  metrics: {
    turns: number;
    errors: number;
    token_usage: number;
    completion_rate: number;
  };
  env_fingerprint: EnvFingerprint;
  /** 沙箱执行证据（v5.0.2 新增，闭合 B2） */
  secure_l1_evidence?: SecureL1Evidence;
}

export interface SecureL1Evidence {
  sandbox_type: 'bwrap' | 'firejail' | 'docker';
  exit_code_verified: boolean;
  execution_trace_hash: string;
  timestamp: string;
}
```

### YAML 示例（v5.0.5 §5.1.5）

```yaml
strategy:
  strategy_id: "sha256:a1b2c3d4e5f6..."
  problem_category: "file_cleanup"
  trigger_conditions: |
    子代理执行完任务后，/tmp 目录残留大量临时文件，
    下次运行时磁盘空间不足导致失败。
  recommended_action: |
    每个子代理在任务完成前，必须执行 `rm -f /tmp/${TASK_PREFIX}*`
    清理本次任务产生的临时文件。
  scope: "general"
  tags: ["cleanup", "subagent", "tmp"]
  instance_ids: ["sha256:f7e8d9c0..."]

instances:
  - instance_id: "sha256:f7e8d9c0..."
    strategy_id: "sha256:a1b2c3d4e5f6..."
    diff_summary: |
      在 video-summarizer SKILL.md 的清理步骤中添加了
      `rm -f /tmp/yt-dlp-* /tmp/whisper-*` 命令。
    files_touched: ["skills/video-summarizer/SKILL.md"]
    env_fingerprint:
      runtime: "openclaw"
      platform: "linux"
      arch: "x64"
      model: "claude-opus-4.7"
    assertions:
      - type: "command_exit_code"
        command: "test ! -f /tmp/yt-dlp-test-marker"
        expected_exit_code: 0
        command_allowlist: ["test"]
        timeout_ms: 5000
        sandbox_profile: "readonly"
    trial_results: []

state: "pending"
```

### 双轨存储（v5.0.5 §5.1.6）

| 存储 | 角色 | 说明 |
|------|------|------|
| **SQLite WAL** | 主存储 | 结构化查询、状态追踪、去重、FTS5 候选搜索 |
| **文件镜像** | 人类可读 | `$WORKSPACE/.self-learning-loop/candidates/<date>/<hash>-<category>.md` |
| **JSONL** | 审计日志 | append-only，永不覆盖（v5.0.5 §12） |

SQLite 表结构（v5.0.5 §5.2.4）：

```sql
CREATE TABLE candidates (
  candidate_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  dormant_reason TEXT,  -- 'no_match' | 'inconclusive' | NULL
  data JSON NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE strategies (
  strategy_id TEXT PRIMARY KEY,
  problem_category TEXT NOT NULL,
  scope TEXT NOT NULL,
  data JSON NOT NULL,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE candidates_fts USING fts5(
  problem_category, trigger_conditions, recommended_action,
  content='candidates', content_rowid='rowid'
);
```

一致性策略：SQLite 优先，文件镜像尽力而为。写入失败不回滚 SQLite（记 audit warn）。`openclaw-learn repair` 可补写缺失镜像。

---

## §A4 Content-addressable ID

继承 v5.0.5 §5.1.4，替代 v4.x 的 nanoid 方案。

### 计算算法

```typescript
import { createHash } from "node:crypto";

/**
 * normalize(): trim + collapse whitespace
 * 内容不变则 ID 不变 —— 天然去重、可校验、跨节点一致。
 */
function normalize(str: string): string {
  return str.trim().replace(/\s+/g, ' ');
}

export function computeStrategyId(s: {
  problem_category: string;
  trigger_conditions: string;
  recommended_action: string;
}): string {
  const payload = `${normalize(s.problem_category)}\n${normalize(s.trigger_conditions)}\n${normalize(s.recommended_action)}`;
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function computeInstanceId(i: {
  strategy_id: string;
  diff_summary: string;
  env_fingerprint: { runtime: string };
}): string {
  const payload = `${i.strategy_id}\n${normalize(i.diff_summary)}\n${i.env_fingerprint.runtime}`;
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}
```

### 优势

- **去重**：同一经验在不同 session 中提炼，ID 相同，自动合并为 Instance
- **可校验**：任何人可验证 ID = SHA256(内容)
- **跨节点一致**：不依赖时间戳或随机数，不同机器对同一内容产生相同 ID
- **v5.0.1 修复（M8）**：输入先 `normalize()`（trim + collapse whitespace），避免空白差异导致不同 ID

---

## §A5 Review Gate 四维校验

继承 v5.0.5 §5.4，候选从 `pending` → `reviewing` 时经过四维审查。

### 四个校验维度

| 维度 | 校验内容 | 失败码 | 可挽救？ |
|------|---------|--------|----------|
| **D1: Schema 校验** | Strategy + Instance 字段完整性、类型正确 | `SCHEMA_INVALID` | ❌ 直接 rejected |
| **D2: Assertion 合理性** | assertion 定义合法（command_allowlist 非空、timeout 在范围内、sandbox_profile 合法） | `ASSERTION_INVALID` | ⚠️ adjust-assertion 修正后重审 |
| **D3: 唯一性** | 与已有 Strategy 相似度 < dedup_threshold (0.9) | `DUPLICATE` | ⚠️ 合并为已有 Strategy 的新 Instance |
| **D4: 可验证性** | 至少有一条可执行的 assertion（type 在 registry 中存在） | `NOT_VERIFIABLE` | ⚠️ 补充 assertion 后重审 |

### 审查流程

```
Candidate (pending)
  │
  ├─ D1: Schema 校验
  │    ├─ 通过 → 继续
  │    └─ 失败 → rejected (SCHEMA_INVALID, 不可挽救)
  │
  ├─ D2: Assertion 合理性
  │    ├─ 通过 → 继续
  │    └─ 失败 → rejected (ASSERTION_INVALID)
  │         └─ 可通过 L4 adjust-assertion 修正后重审
  │
  ├─ D3: 唯一性检查
  │    ├─ 唯一 → 继续
  │    └─ 重复（相似度 ≥ 0.9）→ 合并到已有 Strategy 的新 Instance
  │
  └─ D4: 可验证性检查
       ├─ 可验证 → 全部通过！→ state: validating
       └─ 不可验证 → rejected (NOT_VERIFIABLE)
            └─ 可通过补充 assertion 后重审
```

### Assertion 三重加固（v5.0.5 §6.3.1）

| 层 | 机制 | 说明 |
|----|------|------|
| **command_allowlist** | 白名单 + AST 解析 | 只允许白名单内的程序（argv[0] basename），禁用 shell 元字符 |
| **timeout_ms** | 细粒度超时 | Assertion 级 [100ms, 60s]，Trial 级 [300s, 7200s]，Candidate 级 14400s |
| **sandbox 降级链** | bwrap → firejail → docker → 硬停 | 无沙箱时 command_exit_code 跳过（skipped），不裸执行 |

### AssertionHandler 接口（v5.0.5 §6.3.4）

```typescript
export interface AssertionHandler<TSpec = unknown, TOutput = unknown> {
  readonly type: string;
  readonly schemaVersion: `${number}.${number}`;
  validate(spec: TSpec): ValidationIssue[];
  run(spec: TSpec, ctx: AssertionContext): Promise<AssertionResult<TOutput>>;
  describe?(spec: TSpec): string;
  cleanup?(ctx: AssertionContext): Promise<void>;
}

export type AssertionResult<TOutput = unknown> =
  | { status: "pass";    duration_ms: number; output?: TOutput }
  | { status: "fail";    duration_ms: number; reason: string; output?: TOutput }
  | { status: "timeout"; duration_ms: number }
  | { status: "error";   duration_ms: number; error_code: string; message: string }
  | { status: "skipped"; duration_ms: number; reason: string };
```

### Assertion Registry（v5.0.5 §6.3.3）

**Loader 优先级（右覆盖左）：**
1. Built-in handlers（file_exists / regex_match / command_exit_code / line_count）
2. Workspace custom handlers（`$WORKSPACE/learn/assertions/*.ts`）
3. Candidate-local handlers（runtime_overrides）
4. CLI `--assertion-dir`（仅调试）

**冲突策略：** `keep_builtin`（默认） / `prefer_custom` / `fail_fast`  
**热更新：** SIGHUP / CLI reload / Watch 模式（可选），双缓冲保证并发安全。

---

## §A6 状态机 8 态完整模型

继承 v5.0.5 §5.2，从 v4.7.2 的 11 态精简为 8 态。

### 状态定义

| 状态 | 含义 | 停留条件 |
|------|------|----------|
| **pending** | 刚生成，等待审查 | 四维 Review Gate 尚未执行 |
| **reviewing** | 正在审查中 | Review Gate 执行中 |
| **validating** | 陈化期观察中 | Shadow Runner 正在收集 trial 数据 |
| **graduated** | 已毕业 | 通过所有硬闸门，写入目标文件 |
| **retired** | 已淘汰 | L1/L2 失败或人工 force-retire |
| **rejected** | 被驳回 | Review Gate 未通过或人工 reject |
| **dormant** | 休眠 | 长时间无匹配或 INCONCLUSIVE。必须携带 `dormant_reason`：`no_match`（无 trial 触发）或 `inconclusive`（信号冲突等待更多数据）。v5.0.1 闭合 B3。 |
| **archived** | 归档 | 超过 6 个月不活跃 |

### 完整状态转移表（v5.0.5 §5.2.2，14 条规则）

| # | From | To | Action | Who | 条件 |
|---|------|----|--------|-----|------|
| 1 | pending | reviewing | 进入四维审查 | system | 自动（生成后立即） |
| 2 | reviewing | validating | 审查通过 | system | 四维 Review Gate 全过 |
| 3 | reviewing | rejected | 审查失败 | system | 任一维度不通过 |
| 4 | validating | graduated | 毕业 | system | L1+L2 硬闸门通过 |
| 5 | validating | retired | 淘汰 | system | L1 或 L2 失败 |
| 6 | validating | conflict | 进入冲突仲裁 | system | 检测到与已有候选冲突 |
| 7 | validating | dormant | 休眠 | system | 超过 `dormant_after_days`（默认 30）无 trial |
| 8 | conflict | validating | 仲裁完成 | system/user | Cluster resolved |
| 9 | conflict | retired | 仲裁淘汰 | system/user | Cluster 决定 abandon |
| 10a | dormant(no_match) | validating | 唤醒 | system | 新 session 匹配到该候选 |
| 10b | dormant(inconclusive) | validating | 唤醒 | system | 新 trial 数据到达、L4 用户反馈、或补充环境变更 |
| 11a | dormant(no_match) | retired | 过期淘汰 | system | 超过 `retire_after_dormant_days`（默认 90） |
| 11b | dormant(inconclusive) | retired | 过期淘汰 | system | 超过 30d 无新 trial/反馈 |
| 12 | any except graduated/rejected | graduated | 强制毕业 | user | `override force-graduate` |
| 13 | any except retired/rejected | retired | 强制淘汰 | user | `override force-retire` |
| 14 | reviewing/validating/dormant | rejected | 驳回 | user | L4 feedback: reject |

### ASCII 状态图（v5.0.5 §5.2.3）

```
                    ┌──────────┐
          ┌────────►│ rejected │
          │         └──────────┘
          │ (审查失败/驳回)
          │
  ┌───────┴──┐    审查通过    ┌────────────┐
  │ pending  │──────────────►│ reviewing  │
  └──────────┘               └─────┬──────┘
                                   │
                              通过 │ 失败→rejected
                                   ▼
                           ┌───────────────┐
           ┌──────────────►│  validating   │◄──────────────┐
           │               └───┬───┬───┬───┘               │
           │                   │   │   │                   │
           │         L1+L2 过  │   │   │ 检测冲突          │
           │                   ▼   │   ▼                   │
           │          ┌──────────┐ │ ┌──────────┐  仲裁完成 │
           │          │graduated │ │ │ conflict │──────────┘
           │          └──────────┘ │ └────┬─────┘
           │                      │      │ abandon
           │               L1/L2  │      ▼
      唤醒 │               失败   │ ┌──────────┐
           │                      ▼ │ retired  │
       ┌───┴─────┐     ┌──────────┐ └──────────┘
       │ dormant │◄────│(超时休眠)│
       └─────────┘     └──────────┘
         │ 过期
         ▼
     ┌──────────┐
     │ retired  │
     └──────────┘
```

### 持久化层（v5.0.5 §5.2.4）

SQLite WAL 模式，单写者锁。表结构见 §A3 双轨存储部分。

### 四层短路 Evaluator 真值表（v5.0.5 §6.1.2，13 行）

| # | L1 | L2 | L3 | Verdict | Next State |
|---|----|----|----|---------|-----------| 
| 1 | pass | pass | pass | **PASS** | graduated |
| 2 | pass | pass | fail | **PASS** | graduated |
| 3 | pass | inconc | pass | **PASS_WEAK** | graduated |
| 4 | pass | inconc | fail | **INCONCLUSIVE** | dormant |
| 5 | pass | fail | — | **CONFLICT** | dormant |
| 6 | fail | — | — | **FAIL** | retired |
| 7 | skip | pass | pass | **PASS_L2** | graduated ❗ |
| 8 | skip | pass | fail | **PASS_WEAK** | graduated ❗ |
| 9 | skip | fail | — | **FAIL_L2** | retired |
| 10 | skip | inconc | pass | **INCONCLUSIVE** | dormant |
| 11 | skip | inconc | fail | **LIKELY_FAIL** | dormant |
| 12 | inconc | any | any | **INCONCLUSIVE** | dormant |
| 13 | skip | skip | skip | **SYSTEM_ERROR** | dormant + alert |

**❗ `secure_l1_required` 规则（v5.0.1 B2）：** 含 `command_exit_code` 断言的候选，#7/#8 降级为 INCONCLUSIVE → dormant，除非拥有至少 1 次 SecureL1Evidence。

### Shadow Runner（v5.0.5 §5.5）

**Trial 概念：**
- min_trials: 3（最少），max_trials: 10（最多），max_daily: 5
- 被动观察模式：在真实 session 中检查候选规则是否被遵守

**会话-候选匹配算法（v5.0.5 §5.5.4）：两层筛选，不用 LLM**

```
新 session → 粗筛（problem_category + scope 精确匹配）
          → 细筛（trigger_conditions 关键词 FTS5 匹配，命中 ≥ 2 词）
          → 触发 trial（受偏置防护过滤）
```

**采样偏置防护（v5.0.5 §5.5.3）：**
- `max_same_session_ratio`: 同 session trial 不超 40%（默认）
- `min_unique_sessions`: 进入毕业评估需至少 3 个独立 session 的 trial
- Session 复杂度标记（low/mid/high），分层采样
- 20% 随机跳过防偏置

---

## §A7 毕业产物路由

继承 v5.0.5 §9.1-§9.5 完整毕业路由机制。

### 路由规则表（v5.0.5 §9.1）

| scope 值 | 路由目标 | 注入方式 |
|----------|---------|---------|
| `general` | `$WORKSPACE/AGENTS.md` | 标记块 |
| `tool:<name>` | `$WORKSPACE/TOOLS.md` | 标记块 |
| `role:<name>` | `$WORKSPACE/agents/<role>.md` | 标记块 |
| `skill` | 独立 Skill 包（SKILL.md + scripts/ + tests/） | Symlink Include |

**路由优先级：** `role > tool > general`（最具体优先）

### 标记块注入（v5.0.5 §9.2.2，方式 A，默认）

毕业产物原文存于 `$WORKSPACE/learn/graduated/<content_hash>.md`（content-addressable，不可变）。

通过标记块注入目标文件：

```markdown
<!-- graduated:sha256:a1b2c3d4 start -->
## 规则：子代理完成任务后必须清理临时文件

**触发条件：** ...
**推荐行动：** ...
**来源：** sha256:a1b2c3d4 | 毕业于 2026-04-20 | 5 次 trial 全过
<!-- graduated:sha256:a1b2c3d4 end -->
```

**原子写入（v5.0.1 修复）：** 写临时文件 `<target>.tmp.<pid>` → `rename()`。中间断电不损坏主文件。

### Symlink Include（v5.0.5 §9.2.3，方式 B，scope=skill）

```
$WORKSPACE/skills/<auto-name> → $WORKSPACE/learn/graduated/<hash>/
```

### 回滚机制（v5.0.5 §9.2.4）

- **标记块：** 删除 `<!-- graduated:xxx start -->` 到 `<!-- graduated:xxx end -->` 之间的内容
- **Symlink：** 删除符号链接
- 支持 `openclaw-learn override revert <graduation_id>` 命令

### Git 追踪（v5.0.5 §9.2.5）

`graduated/` 目录推荐入库：
- `git log learn/graduated/` 审计所有毕业产物
- `git revert` 撤销毕业
- 跨机 clone 自动获得所有毕业产物

### graduation_record Schema（v5.0.5 §9.3）

```yaml
graduation_record:
  candidate_id: "sha256:a1b2c3d4..."
  strategy_id: "sha256:e5f6a7b8..."
  instance_id: "sha256:f7e8d9c0..."

  shadow_trial_count: 5
  l1_assertion_results:
    total: 15
    passed: 15
    failed: 0
    skipped: 0
  l2_metrics_delta:
    turns: -0.3
    errors: -1.2
    token_usage: -500
    completion_rate: +0.05
  l3_judge:
    verdict: "pass"
    confidence: 0.85
    rationale: "规则明确可执行，assertion 覆盖充分"
  l4_feedback: null

  graduated_at: "2026-04-20T14:30:00+08:00"
  graduated_by: "system"  # "system" | "user:显超"
  env_fingerprint:
    runtime: "openclaw"
    platform: "linux"
    arch: "x64"

  scope: "general"
  target_file: "AGENTS.md"
  injection_method: "marker_block"  # marker_block | symlink

  rollback_checkpoint:
    git_commit: "abc123def"
    marker_id: "graduated:sha256:a1b2c3d4"
```

### Skill 封装路径（v5.0.5 §9.4，scope=skill）

```
$WORKSPACE/learn/graduated/sha256_a1b2c3d4/
├── SKILL.md           # 自动生成
├── scripts/check.ts   # 从 assertion 自动生成
├── tests/check.test.ts
└── package.json
```

### 跨 scope 冲突处理（v5.0.5 §9.5）

最具体优先。同时命中 `general` 和 `role:鲁班` → 写入 `agents/鲁班.md`，AGENTS.md 不重复写入。

---

## §A8 contentHash 去重算法

继承 v5.0.5 §4.4.2 完整去重机制。

### 事件级去重

```typescript
import { createHash } from "node:crypto";

// v5.0.1 修复：32 字符（128 bit），原 16 字符仅 64 bit 碰撞风险高
export function computeContentHash(event: SessionEvent): string {
  return createHash("sha256")
    .update(`${event.type}:${event.content}`)
    .digest("hex")
    .slice(0, 32);  // 32 chars = 128 bit
}
```

**去重规则（v5.0.5 §4.4.2）：**

1. `contentHash = SHA256(type + ":" + content)` 取前 32 字符（128 bit）
2. 同一 contentHash 在 30 秒时间窗口内视为重复
3. 跨 Runtime 重复保留 env_fingerprint 更丰富的一条（`preferRicherEnv` 算法）
4. 去重在 Candidate Generator 输入侧执行，采集层不修改原始数据

### preferRicherEnv 算法（v5.0.2 新增）

```typescript
function envRichnessScore(env: EnvFingerprint): number {
  let score = 0;
  if (env.runtime) score += 1;
  if (env.platform) score += 1;
  if (env.arch) score += 1;
  if (env.model) score += 1;
  if (env.nodeVersion) score += 1;
  if (env.extensions && Object.keys(env.extensions).length > 0)
    score += Object.keys(env.extensions).length;
  return score;
}

function preferRicherEnv(existing: SessionEvent, incoming: SessionEvent): SessionEvent {
  const es = envRichnessScore(existing.env_fingerprint);
  const is_ = envRichnessScore(incoming.env_fingerprint);
  if (is_ > es) return incoming;
  if (is_ < es) return existing;
  // tie-breaker: 保留时间戳更新的
  return incoming.timestamp > existing.timestamp ? incoming : existing;
}
```

### 候选级去重

候选级去重由 Review Gate D3 维度执行：
- 新候选与已有 Strategy 的相似度 > `dedup_threshold` (0.9) → 合并为 Instance
- Skill 层不重复实现

### Trial 级去重（v5.0.1 B4）

独立于事件去重，三元组去重键：`candidate_id + runtime + session_id`

---

## §A9 EvoMap Bridge / Parliament Hook（Phase 2+ 标注）

以下功能为 **Phase 2+** 规划，当前版本不含，但接口已预留。

### EvoMap Bridge（v5.0.5 §10）

**定位：** 可选的出站/入站层。学习内核在 `bridge.endpoint = null` 时照常运行。

**三种交互模式：**
- **Outbound Publish：** 毕业资产映射为 Gene + Capsule + EvolutionEvent 三元组发布
- **Inbound Search：** 搜索 EvoMap Hub 上的经验资产
- **Inbound Fetch：** 拉取外部资产，**强制从 validating 起跑**（不因外部声誉跳过验证）

**Gene + Capsule 映射（v5.0.5 §10.2）：**

| 本地概念 | EvoMap 概念 |
|---------|------------|
| Strategy | Gene |
| Instance（含 env/metrics） | Capsule |
| graduation_record | EvolutionEvent |

**Proxy 架构：** 通过 `localhost:19820` Evolver Proxy 通信。Proxy 不可达时降级为本地队列。

**A2A envelope：** 出站/入站采用 GEP-A2A envelope 协议。内核内部不用 A2A。

### Parliament Hook（v5.0.5 §3.3 #11）

**定位：** 可选外部决策服务。默认关闭，Override CLI 独立运行不依赖。

**当前状态：** 接口预留（Hook 点已定义），Phase 2+ 实装。

### Phase 边界

| Phase | 范围 |
|-------|------|
| Phase 1 | 单 Runtime（OpenClaw）跑通全闭环，接口预留 Bridge/Parliament Hook 点 |
| Phase 2 | 跨 Runtime 采集 + EvoMap Bridge 最小版 |
| Phase 3 | Skill 格式产物 + Dashboard + Parliament 实装 + 开源文档 |
