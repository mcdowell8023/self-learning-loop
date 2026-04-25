---
name: self-learning-loop
version: 1.1.0
description: >
  Cross-runtime self-learning loop: auto-extract experience candidates from work sessions,
  verify via four-dimension Review Gate and shadow trials, graduate proven rules into
  AGENTS.md/TOOLS.md. Supports OpenClaw, Claude Code, OpenCode, Codex.
  Triggers: "反思下", "/reflect", or daily cron.
  Keywords: learning, reflection, memory, experience, self-improvement, candidate, graduation
author: mcdowell8023
tags: [memory, learning, reflection, self-improvement]
requires: [exec, read, write]
---

# self-learning-loop

## 能力

你拥有自学习能力。通过分析工作会话记录，你可以自动提炼经验教训，
形成结构化的 Strategy + Instance 候选（Content-addressable ID），
经过四维 Review Gate 审查和影子观察（Shadow Trial）验证后，
将高质量经验毕业为可执行规则，自动注入 AGENTS.md / TOOLS.md 等工作规范。

**数据模型：** Strategy（策略模板）+ Instance（具体实例）双层模型，继承 v5.0.5 §5.1。
**状态机：** 8 态完整模型（pending → reviewing → validating → graduated/retired/rejected/dormant/archived）。
**跨 Runtime：** 通过 RuntimeAdapter 接口支持 OpenClaw / Claude Code / OpenCode / Codex 四个 runtime。

## 触发条件

当用户说以下任一口令时，执行反思流程：
- 「反思下」「学习一下」
- `/reflect` `/learn`

## 工作流

### 1. 检测环境

确认 self-learning-loop 已初始化：

```bash
openclaw-learn status
```

如果返回错误，提示用户运行安装：

```bash
bash <SKILL_DIR>/scripts/setup.sh
```

### 2. 检查数据就绪（冷启动分支）

如果 `openclaw-learn status` 返回 0 个可用 session：

```
⚠️ 没有发现可反思的 session。需要至少 1 个完整的工作 session 才能触发有效反思。

提示：
- 先正常工作一段时间，让闭环采集到 session 数据。
- 首次安装后 `reflection_watermark` 已初始化为安装时间戳，
  所有安装后产生的 session 都会被纳入反思范围。
- 建议安装后至少使用 1 周再启用 cron（让数据池热身）。
- 如需手动指定反思范围：openclaw-learn reflect --since 2026-04-20
```

友好退出，不报错。

### 3. 执行反思

```bash
openclaw-learn reflect
```

反思引擎会：
1. 通过 RuntimeAdapter 采集新增 session 事件（增量，基于 `reflection_watermark`）
2. 事件级去重（contentHash + 30s 窗口，v5.0.5 §4.4.2）
3. LLM 反思产出 0-3 条候选（confidence < 0.3 直接丢弃）
4. 新候选通过四维 Review Gate 审查
5. 通过审查的候选进入 Shadow 陈化期

### 4. 报告结果

读取 CLI 输出，向用户汇报：
- 分析了多少 section / session
- 产出了多少条新候选（Strategy + Instance）
- 各候选的简要描述和 confidence
- 当前各状态候选计数

### 5. 查看整体状态

```bash
openclaw-learn status
```

## CLI 完整命令清单

以下 12 个命令覆盖闭环管理全流程：

### 状态总览

```bash
openclaw-learn status
```

显示候选总数、各状态分布、最近反思时间、reflection_watermark、cron 状态。

### 手动反思

```bash
openclaw-learn reflect
```

立即执行一次完整的采集 + 反思流程。支持 `--since YYYY-MM-DD` 指定起始时间。

### 候选审查

```bash
# 列出候选（默认显示 pending/validating/dormant）
openclaw-learn review list

# 查看候选详情（含 trial 结果、assertion 状态、Strategy + Instance 信息）
openclaw-learn review show <candidate_id>
```

### 人工干预（Override）

Override 与 Parliament 解耦，独立可用，是安全阀（v5.0.5 §7）。

```bash
# 强制毕业（跳过所有闸门，仅限 user 操作）
openclaw-learn override force-graduate <id> --reason "经验证确实有效"

# 强制退役
openclaw-learn override force-retire <id> --reason "场景不再适用"

# 回滚已毕业内容（24h 内可撤销）
openclaw-learn override revert <graduation_id>
```

### 审计日志

全生命周期审计，JSONL 格式，append-only，永不覆盖（v5.0.5 §12）。

```bash
# 列出审计事件
openclaw-learn audit list [--since 7d] [--action graduated]

# 复现完整事件链
openclaw-learn audit replay <correlation_id>

# 统计摘要（毕业率、淘汰率、平均 shadow 天数等）
openclaw-learn audit stats [--since 30d]
```

### 配置查看

```bash
# 显示当前生效配置（标注每项来源：env / project / user / default）
openclaw-learn config show
```

### 数据修复

```bash
# 修复 SQLite ↔ 文件镜像不一致（补写缺失的镜像文件）
openclaw-learn repair
```

## 查看详情（L3 按需加载）

以下 references 文档包含深度技术细节，按需加载：

| 需要了解的内容 | 读取文件 |
|---------------|---------|
| 分层架构、双层数据模型、8 态状态机、Review Gate、毕业路由、去重算法 | `references/architecture.md` |
| 触发口令、cron 配置、事件驱动、冷启动说明、CLI 完整清单 | `references/triggers.md` |
| 配置项全表、质量参数调优、shadow 调优、Dreaming 整合 | `references/customization.md` |
| 四 Runtime 对照表、三级注册发现、GenericAdapter YAML DSL、能力差异 | `references/runtime-integration.md` |
