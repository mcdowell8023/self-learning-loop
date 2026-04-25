# Customization Reference — self-learning-loop v1.1

> **架构基线：** learning-loop-design-v5.0.5.md  
> **本文件包含配置项全表、质量参数调优指南、shadow 调优、Dreaming 整合参数和多 runtime 共存配置。**

---

## §C1 配置项全表

### 配置加载优先级

| # | 来源 | 路径 / 方式 | 说明 |
|---|------|-----------|------|
| 1 | 环境变量 | `OPENCLAW_LEARN_*` | 最高优先级，覆盖一切 |
| 2 | 项目级配置 | `$WORKSPACE/learn/config.yaml` | 当前 workspace 专用 |
| 3 | 用户级配置 | `~/.openclaw/learn/config.yaml` | 跨 workspace 共享默认值 |
| 4 | 内置默认值 | 代码硬编码 | 保证所有字段都有值 |

环境变量映射规则：`OPENCLAW_LEARN_` + 大写路径 + `_` 分隔。  
示例：`shadow.min_trials` → `OPENCLAW_LEARN_SHADOW_MIN_TRIALS`

### 完整配置 Schema

```yaml
# learn.config.yaml — self-learning-loop 配置文件
# 所有项均可省略，省略则用默认值。

# ─── 日记源 ───────────────────────────────────────────
diary:
  path: "memory/*.md"                  # 日记文件 glob
  format:
    type: "four-grid"                  # "four-grid" | "freeform" | "json"
    section_separator: "###"           # 按三级标题切分
    skip_tags: []                      # 跳过包含这些标签的 section
  date_pattern: "YYYY-MM-DD"

# ─── Runtime Adapter ────────────────────────────────
adapters:
  - name: openclaw
    enabled: true
    agents_root: ~/.openclaw/agents         # v5.0.5 §4.2.1 主路径
    legacy_session_dir: ~/.openclaw/sessions
  - name: claude-code
    enabled: false                          # Phase 2 才实装
    projects_root: ~/.claude/projects       # ⚠️ 待实测
    legacy_session_dir: ~/.claude/sessions
  - name: opencode
    enabled: false                          # Phase 2 才实装
    db_path: ~/.local/share/opencode/opencode.db
    acp:
      enabled: false
      port: 4096
  - name: codex
    type: generic
    yaml_mapping: configs/codex-mapping.yaml

# ─── 存储 ───────────────────────────────────────────
storage:
  workspace: "$WORKSPACE/.self-learning-loop"
  sqlite_path: "candidates.db"
  mirror_dir: "candidates"

# ─── 触发 ───────────────────────────────────────────
triggers:
  voice_commands: ["反思下", "学习一下"]
  cli_aliases: ["/reflect", "/learn"]

# ─── 运行时检测 ─────────────────────────────────────
runtime:
  detection: "auto"                    # "auto" | "openclaw" | "claude-code" | "opencode" | "codex"

# ─── 采集层 ─────────────────────────────────────────
collect:
  interval_min: 30                     # 采集间隔 [5, 1440] 分钟
  filters:
    min_turns: 3                       # 忽略 < 3 轮的会话
    min_tool_calls: 1                  # 至少 1 次工具调用才采集
    exclude_labels: ["test", "debug"]
  dedup:
    mode: content_hash_window
    window_ms: 30000                   # 30 秒去重窗口
    prefer_richer_env: true

# ─── 反思引擎 ───────────────────────────────────────
reflect:
  model: "claude-sonnet-4.6"
  fallback_model: "gpt-5-mini"
  temperature: 0.3
  max_candidates_per_session: 3        # 每次反思 0-3 条（v5.0.5 §5.3.3）
  min_confidence: 0.3                  # 低于此阈值直接丢弃（v5.0.5 §5.3.3）
  dedup_threshold: 0.9                 # 与已有 Strategy 相似度超此值合并为 Instance
  cron: "30 22 * * *"                  # 每晚 22:30 自动反思
  daily_token_budget: 50000            # 闭环日 token 上限
  daily_token_budget_action: skip      # 超限行为：skip | warn

# ─── 影子试验 ───────────────────────────────────────
shadow:
  min_trials: 3                        # 最少观察次数
  max_trials: 10                       # 最多观察次数
  max_daily: 5                         # 每日最多 shadow 并发
  observation_mode: "passive"          # "passive" | "active"（Phase 2+）
  max_same_session_ratio: 0.4          # 同 session trial 不超 40%（v5.0.5 §5.5.3）
  min_unique_sessions: 3               # 毕业评估需至少 3 个独立 session（v5.0.5 §5.5.3）

# ─── 决策层 ─────────────────────────────────────────
decision:
  confidence_threshold:
    high: 0.7                          # ≥ high → auto_decide
    low: 0.5                           # < low → escalate
  l3_enabled: false                    # L3 LLM judge（Phase 2+）
  sandbox:
    fallback_chain: ["bwrap", "firejail", "docker"]

# ─── 毕业阈值 ───────────────────────────────────────
graduation:
  confidence_high: 0.7
  confidence_low: 0.5
  auto_graduate: false                 # false = 需要人工确认（推荐）

# ─── 休眠与淘汰 ─────────────────────────────────────
dormant:
  dormant_after_days: 30               # 无 trial 后多久休眠
  retire_after_dormant_days: 90        # 休眠后多久淘汰（no_match）
  inconclusive_retire_days: 30         # inconclusive 休眠后多久淘汰
```

### 配置加载流程

```
环境变量 OPENCLAW_LEARN_*
        ↓ 合并
$WORKSPACE/learn/config.yaml（项目级）
        ↓ 合并
~/.openclaw/learn/config.yaml（用户级）
        ↓ 合并
内置默认值（代码 hardcode）
        ↓
Zod schema 校验
        ↓
    ✅ 生效  /  ❌ 校验失败 → 保持旧配置 + audit event
```

`openclaw-learn config show` 标注每项来源（env / project / user / default）。

---

## §C2 质量参数调优

### 核心质量参数

继承 v5.0.5 §5.3.3 反思素材最小集和质量控制。

#### min_confidence（最低置信度阈值）

| 配置键 | 默认值 | 范围 | v5.0.5 引用 |
|--------|--------|------|-------------|
| `reflect.min_confidence` | 0.3 | [0.0, 1.0] | §5.3.3 |

**作用：** LLM 反思产出的候选，confidence 低于此阈值直接丢弃，不进入 pending 状态。

**调优建议：**

| 场景 | 建议值 | 理由 |
|------|--------|------|
| 初始探索期 | 0.2 | 降低门槛，多收集候选观察质量 |
| 稳定运行期 | 0.3（默认） | 平衡覆盖率和噪声 |
| 高质量要求 | 0.5 | 减少低质量候选，降低 review 负担 |

#### dedup_threshold（去重相似度阈值）

| 配置键 | 默认值 | 范围 | v5.0.5 引用 |
|--------|--------|------|-------------|
| `reflect.dedup_threshold` | 0.9 | [0.5, 1.0] | §5.3.3 |

**作用：** 新候选与已有 Strategy 的相似度超过此值，合并为已有 Strategy 的新 Instance 而非新建 Strategy。

**调优建议：**

| 场景 | 建议值 | 理由 |
|------|--------|------|
| 多样化探索 | 0.95 | 更严格的去重，允许更多近似策略共存 |
| 默认 | 0.9 | 平衡去重和多样性 |
| 严格去重 | 0.8 | 积极合并相似策略，减少候选数量 |

#### max_candidates_per_session（每 session 最大候选数）

| 配置键 | 默认值 | 范围 | v5.0.5 引用 |
|--------|--------|------|-------------|
| `reflect.max_candidates_per_session` | 3 | [1, 10] | §5.3.3 |

**作用：** 限制单次反思产出的候选数量。LLM 自行判断 0-N 条（不超过此值）。

**调优建议：**
- 保持默认值 3，覆盖绝大多数场景
- 复杂长 session（>100 轮）可适当提高到 5
- 日志量大时降低到 1-2 以节省 token

---

## §C3 Shadow 调优

### 样本偏差保护参数

继承 v5.0.5 §5.5.3 shadow 样本偏差保护。

#### max_same_session_ratio（同 session trial 比例上限）

| 配置键 | 默认值 | 范围 | v5.0.5 引用 |
|--------|--------|------|-------------|
| `shadow.max_same_session_ratio` | 0.4 | [0.1, 1.0] | §5.5.3 |

**作用：** 同一 session 产生的 trial 不超过 trial 总数的此比例。防止单一 session 偏见。

**调优建议：**

| 场景 | 建议值 | 理由 |
|------|--------|------|
| 单项目 Agent | 0.6 | session 种类有限，放宽限制 |
| 默认 | 0.4 | 平衡 |
| 多项目/多团队 | 0.3 | session 种类丰富，要求更多样本 |

#### min_unique_sessions（最少独立 session 数）

| 配置键 | 默认值 | 范围 | v5.0.5 引用 |
|--------|--------|------|-------------|
| `shadow.min_unique_sessions` | 3 | [1, 20] | §5.5.3 |

**作用：** 候选进入毕业评估前，trial 必须来自至少 N 个不同 session。

**调优建议：**
- 默认 3 是最低推荐值
- 高风险规则（scope=general，影响所有角色）建议 5+
- 低风险规则（scope=tool:xxx）可保持 3

### Shadow 调度参数

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `shadow.min_trials` | 3 | 最少 trial 次数 |
| `shadow.max_trials` | 10 | 最多 trial 次数（超过强制判定） |
| `shadow.max_daily` | 5 | 每日最多 shadow 并发 |
| `shadow.observation_mode` | "passive" | Phase 1 仅支持 passive |

### 复杂度分层采样

Shadow Runner 自动对 session 进行复杂度标记：

| 复杂度 | 判断标准 |
|--------|---------|
| low | 轮数 < 10 且 tool_call < 3 且 error = 0 |
| mid | 10 ≤ 轮数 < 30 或 3 ≤ tool_call < 10 |
| high | 轮数 ≥ 30 或 tool_call ≥ 10 或 error ≥ 2 |

**防护措施：** 若 trial 中 >80% 为 low 复杂度，追加 mid/high session 再评。

---

## §C4 Dreaming 整合参数

### Token 预算

| 配置键 | 默认值 | 说明 | v5.0.5 / Dreaming 引用 |
|--------|--------|------|----------------------|
| `reflect.daily_token_budget` | 50000 | 闭环日 token 上限 | Dreaming 整合 M6 |
| `reflect.daily_token_budget_action` | "skip" | 超限行为 | — |

**总预算规划：**

| 组件 | 日 token 消耗 |
|------|-------------|
| 闭环反思 | ~50,000（daily_token_budget 限制） |
| Dreaming Light Sleep（6h/天） | ~50,000 |
| Dreaming Deep Sleep（1次/天） | ~60,000 |
| Dreaming REM（1次/周，分摊） | ~20,000/天 |
| **总计** | **~175,000/天** |
| 余量 | 5%（~8,750） |

### Cron 错峰配置

```yaml
reflect:
  cron: "30 22 * * *"   # 闭环反思：22:30
  cron_constraint_note: |
    必须避开 Dreaming Deep Sleep（默认 03:00-04:00）。
    闭环 + Dreaming 总预算约 175,000 token/天。
```

**时间线：**

```
22:30  闭环自动反思
23:00  Dreaming Light Sleep 开始
03:00  Dreaming Deep Sleep 开始 ← ⚠️ 禁止闭环调度
03:55  daily-memory-consolidation
04:00  Dreaming Deep Sleep 结束
06:00  Dreaming Light Sleep 周期恢复
```

### 超限行为

| `daily_token_budget_action` | 行为 |
|----------------------------|------|
| `skip`（默认） | 跳过本次反思，记审计事件 `reflect_skipped_budget` |
| `warn` | 执行反思但记审计警告 `reflect_budget_warning` |

---

## §C5 多 Runtime 共存配置示例

### 场景：OpenClaw + Claude Code 共用一个 workspace

```yaml
# learn.config.yaml

adapters:
  - name: openclaw
    enabled: true
    agents_root: ~/.openclaw/agents
    legacy_session_dir: ~/.openclaw/sessions
  - name: claude-code
    enabled: true
    projects_root: ~/.claude/projects
    legacy_session_dir: ~/.claude/sessions

storage:
  workspace: "$WORKSPACE/.self-learning-loop"
  # SQLite WAL 模式支持多 Adapter 并发写入
  # busy_timeout 默认 5000ms

collect:
  dedup:
    mode: content_hash_window
    window_ms: 30000
    prefer_richer_env: true
    # 跨 Runtime 去重：同一候选在不同 Runtime 被提取时自动合并
```

### 场景：OpenClaw + OpenCode + Codex（三 Runtime）

```yaml
adapters:
  - name: openclaw
    enabled: true
    agents_root: ~/.openclaw/agents
  - name: opencode
    enabled: true
    db_path: ~/.local/share/opencode/opencode.db
  - name: codex
    type: generic
    yaml_mapping: configs/codex-mapping.yaml

# 多 Runtime 特有配置
shadow:
  # 推荐跨 Runtime 验证：通用规则在多环境中都要有 trial
  min_unique_sessions: 5    # 提高到 5，确保跨 Runtime 覆盖
  max_same_session_ratio: 0.3

decision:
  confidence_threshold:
    high: 0.75   # 多 Runtime 时略微提高阈值，要求更多证据
```

### 场景：仅 OpenClaw（默认，零配置）

不需要任何配置文件。内置默认值已覆盖：

| 配置项 | 默认值 |
|--------|--------|
| adapter | OpenClawAdapter（自动检测） |
| session 路径 | `~/.openclaw/agents/*/sessions/*.jsonl` |
| 存储 | `$WORKSPACE/.self-learning-loop/` |
| cron | `30 22 * * *` |
| 所有质量参数 | 见 §C1 默认值列 |

### 并发控制

多 Runtime 共享同一 SQLite 数据库时：

| 场景 | 机制 |
|------|------|
| 多 Adapter 并行采集 | `Promise.allSettled()` 并行，SQLite WAL 支持并发读 |
| 多 Adapter 并发写候选 | SQLite 单写者锁 + `busy_timeout`（默认 5000ms） |
| 跨 Runtime 去重 | 事件级 contentHash + 候选级 Strategy ID |

### 配置冲突排查

```bash
# 查看当前生效配置及来源
openclaw-learn config show

# 输出示例：
# reflect.model: "claude-sonnet-4.6" (default)
# reflect.cron: "0 23 * * *" (project: $WORKSPACE/learn/config.yaml)
# shadow.min_trials: 5 (env: OPENCLAW_LEARN_SHADOW_MIN_TRIALS)
```
