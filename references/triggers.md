# Triggers Reference — self-learning-loop v1.1

> **架构基线：** learning-loop-design-v5.0.5.md  
> **本文件描述所有触发方式、CLI 命令清单、cron 配置和冷启动说明。**

---

## §T1 触发口令表 + CLI Aliases

### 语音口令

| 口令 | 语言 | 说明 |
|------|------|------|
| `反思下` | 中文 | 主要触发词 |
| `学习一下` | 中文 | 备选触发词 |

Agent 在 SKILL.md 工作流中匹配这些口令，自动执行 `openclaw-learn reflect`。

### CLI Aliases

| Alias | 映射命令 | 说明 |
|-------|---------|------|
| `/reflect` | `openclaw-learn reflect` | 主 CLI alias |
| `/learn` | `openclaw-learn reflect` | 备选 alias |

这些 alias 在 SKILL.md 的触发条件中声明，由各 Runtime 的 Skill 加载机制识别。

### 配置自定义（learn.config.yaml）

```yaml
triggers:
  voice_commands: ["反思下", "学习一下"]
  cli_aliases: ["/reflect", "/learn"]
```

用户可在配置文件中添加自定义口令或 alias。

---

## §T2 Cron 自动触发

### 默认 Cron 配置

```
30 22 * * *    bash <SKILL_DIR>/scripts/daily-reflect.sh
```

**默认时间：每晚 22:30**

### Dreaming 错峰约束

**⚠️ 必须避开 Dreaming Deep Sleep 时间窗（默认 03:00-04:00）。**

| 时间段 | 占用者 | 说明 |
|--------|--------|------|
| 22:30 | self-learning-loop 自动反思 | 默认 cron 时间 |
| 03:00-04:00 | Dreaming Deep Sleep | **禁止调度任何反思或采集任务** |
| 03:55 | daily-memory-consolidation | 日终记忆提炼 |

**为什么避开 03:00-04:00：**
- Dreaming Deep Sleep 是高 token 消耗的深度反思阶段
- 同时运行闭环反思会导致 token 冲突和 LLM 调用争抢
- 总预算约 175,000 token/天（闭环 50,000 + Dreaming ~130,000），留 5% 余量

**配置说明（learn.config.yaml）：**

```yaml
reflect:
  cron: "30 22 * * *"
  cron_constraint_note: |
    必须避开 Dreaming Deep Sleep 时间窗（默认 03:00-04:00）。
    如果用户调整了 Dreaming 时间窗，需同步调整本 cron。
  daily_token_budget: 50000
  daily_token_budget_action: skip  # 超限行为：skip | warn
```

### 各 Runtime Cron 注册方式

| Runtime | Cron 注册方式 | 命令 |
|---------|-------------|------|
| **OpenClaw** | `openclaw cron add` 原生支持 | `openclaw cron add --schedule "30 22 * * *" --command "bash <path>/daily-reflect.sh"` |
| **Claude Code** | system crontab | `crontab -e` 手动添加 |
| **OpenCode** | system crontab | `crontab -e` 手动添加 |
| **Codex** | system crontab | `crontab -e` 手动添加 |

### daily-reflect.sh 行为

```bash
#!/usr/bin/env bash
# 1. 检查 daily_token_budget 是否超限
# 2. 执行 openclaw-learn reflect
# 3. 写日志到 $WORKSPACE/.self-learning-loop/logs/
# 4. 异常退出时发审计事件
```

---

## §T3 事件驱动触发

**仅 OpenClaw 支持。** 其他 Runtime 无原生 session 生命周期 hook。

### 触发机制

基于 `openclaw-runtime-capability-map.md` §2-§3 的关键发现：

| 能力 | OpenClaw 现状 | 适配策略 |
|------|-------------|---------|
| `session.onEnd` hook | ❌ 不可用 | **采集只能用 cron 主动轮询** |
| transcript 读取 | ✅ 可用 | 直接读取 JSONL |
| subagent spawn | ✅ 可用 | 用于 shadow trial |

**现实：** 即使在 OpenClaw 中，事件驱动触发也依赖 cron 轮询实现。
采集 cron 每 30 分钟 tick（默认），检测新 session 并触发反思。

### 采集 Cron Tick 流程

```
cron tick（默认 every 30min）
  │
  ├─ 并行：各 Adapter.listNewSessions(since)
  │     └─ 逐 session: Adapter.extractEvents(ref)
  │
  ▼ merge + deduplicateEvents()
  │
  ▼ CandidateGenerator.reflect(events)
  │
  ▼ 0-3 candidates written to store
```

### 配置

```yaml
collect:
  interval_min: 30  # 采集间隔，范围 [5, 1440]
```

---

## §T4 手动 / 批量触发

### 手动立即反思

```bash
openclaw-learn reflect
```

执行一次完整的采集 + 反思流程。从 `reflection_watermark` 开始处理新增 session。

### 指定时间范围

```bash
openclaw-learn reflect --since 2026-04-18
```

忽略 `reflection_watermark`，从指定日期开始处理所有 session。适用于：

- 首次安装后回溯历史 session
- watermark 异常需要重新处理
- 排障时需要分析特定时间段

### 批量触发注意事项

- `--since` 不会更新 `reflection_watermark`，下次正常 cron 仍从 watermark 继续
- 大时间跨度可能产生大量候选，注意 `max_candidates_per_session: 3` 限制
- `daily_token_budget` 仍然生效，超限时根据 `daily_token_budget_action` 决定行为

---

## §T5 冷启动

### 首次安装后的行为

当 `openclaw-learn status` 检测到 0 个可用 session 时：

1. **不报错**——友好提示用户需要先正常工作一段时间
2. **`reflection_watermark` 初始化**——setup.sh 执行时自动设为安装时间戳
3. **推荐热身期**——安装后至少 1 周再启用 cron

### 友好提示文案

```
⚠️ 没有发现可反思的 session。

当前状态：
  - reflection_watermark: 2026-04-25T19:00:00+08:00（安装时间）
  - 可用 session: 0

提示：
  1. 先正常使用 Agent 工作一段时间，让闭环采集到 session 数据
  2. 首次安装后建议至少 1 周再启用 cron（让数据池热身）
  3. 如需手动指定范围：openclaw-learn reflect --since 2026-04-20
  4. 查看采集状态：openclaw-learn status
```

### reflection_watermark 机制

| 场景 | watermark 行为 |
|------|---------------|
| 首次安装 | `setup.sh --watermark-now` 设为安装时间戳 |
| 正常反思 | 每次反思完成后更新为最新 session 时间戳 |
| `--since` 手动 | 不更新 watermark |
| 重置 | `openclaw-learn config set reflection_watermark <timestamp>` |

### 冷启动安全检查清单

```
openclaw-learn status 检查项：
  ✓ SQLite 数据库存在且可读写
  ✓ 至少 1 个 Adapter detect() 返回 true
  ✓ 至少 1 个 session 文件存在且可解析
  ✗ 以上任一不满足 → 友好退出 + 引导
```

---

## §T6 Phase 1 CLI 完整命令清单

12 个命令，覆盖闭环管理全流程：

### 状态与反思

| 命令 | 用途 | 说明 |
|------|------|------|
| `openclaw-learn status` | 状态总览 | 候选分布、watermark、cron 状态 |
| `openclaw-learn reflect` | 手动反思 | 立即执行采集 + 反思，支持 `--since` |

### 候选审查

| 命令 | 用途 | 说明 |
|------|------|------|
| `openclaw-learn review list` | 列出候选 | 默认 pending/validating/dormant |
| `openclaw-learn review show <id>` | 候选详情 | 含 trial、assertion、Strategy + Instance |

### 人工干预（Override）

| 命令 | 用途 | 说明 |
|------|------|------|
| `openclaw-learn override force-graduate <id>` | 强制毕业 | 跳过所有闸门，仅 user 可用 |
| `openclaw-learn override force-retire <id>` | 强制退役 | 标记不再适用 |
| `openclaw-learn override revert <graduation_id>` | 回滚毕业 | 24h 内可撤销 |

### 审计日志

| 命令 | 用途 | 说明 |
|------|------|------|
| `openclaw-learn audit list` | 列出审计事件 | 支持 `--since`/`--action`/`--candidate` |
| `openclaw-learn audit replay <id>` | 复现事件链 | 按 correlation_id 追踪 |
| `openclaw-learn audit stats` | 统计摘要 | 毕业率、淘汰率、平均 shadow 天数 |

### 配置与维护

| 命令 | 用途 | 说明 |
|------|------|------|
| `openclaw-learn config show` | 配置查看 | 标注每项来源（env/project/user/default） |
| `openclaw-learn repair` | 数据修复 | 补写 SQLite ↔ 文件镜像不一致 |

### Exit Code 约定

| Code | 含义 |
|------|------|
| 0 | 成功 |
| 1 | 一般错误 |
| 2 | Schema / 参数校验失败 |
| 3 | 候选状态不允许该操作 |
| 4 | 候选在 Conflict Cluster 中 |
| 5 | 权限不足（Agent 尝试 force-graduate） |

### 常用参数

| 参数 | 适用命令 | 说明 |
|------|---------|------|
| `--since <date>` | reflect, audit list | 指定起始时间 |
| `--reason <text>` | override force-* | 必填（≥ 10 字符） |
| `--state <state>` | review list | 过滤状态 |
| `--action <action>` | audit list | 过滤审计 action |
| `--json` | 多个命令 | JSON 输出格式 |
| `--verbose` | 多个命令 | 详细输出 |
