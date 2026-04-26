# self-learning-loop · 快速上手卡

> v1.1.0-alpha.1 · 2026-04-25
> 5 分钟看懂，10 分钟跑通。

---

## 这个 Skill 是什么

让你的 AI agent **自动从工作记录里提炼经验教训**，经过审查和影子观察后，把验证过的规则**自动写进 AGENTS.md / TOOLS.md**，下次会话开始时自动加载。

**简单说：让 AI 越用越懂你。**

支持 4 个 runtime：OpenClaw / Claude Code / Opencode / Codex。

---

## 安装（一行命令）

```bash
cd ~/open-claw-output/code/learning-loop
bash scripts/setup.sh --mode local
```

会做这些事：
- 复制 SKILL.md + references/ 到 `~/.openclaw/workspace/skills/self-learning-loop/`
- 复制到 `~/.local/share/opencode/skills/self-learning-loop/`（如果有 opencode）
- 注册 CLI 到 `~/.local/bin/openclaw-learn`
- 在 `~/.openclaw/workspace/learn/` 创建 SQLite + config.yaml + audit log

**如果想看会做什么但不真做：** 加 `--dry-run`

---

## 验证安装成功

```bash
# 1. CLI 在 PATH 里
which openclaw-learn

# 2. 健康检查
openclaw-learn status
# 期望输出：(no candidates) 或类似

# 3. OpenClaw 能识别 skill
openclaw skills list 2>&1 | grep self-learning-loop
# 期望：列出，无 symlink-escape 错误

# 4. 数据目录
ls ~/.openclaw/workspace/learn/
# 期望：audit/  candidates.db  config.yaml
```

---

## 日常使用

### 触发反思

在 OpenClaw / Claude Code 主会话里直接说：

```
反思下
```

或：

```
/reflect
```

或命令行：

```bash
openclaw-learn reflect --today
```

会做：
1. 扫描今日 session 历史
2. 调 LLM 提炼 candidate（Strategy + Instance）
3. 写到 SQLite + 文件镜像（`~/.openclaw/workspace/learn/candidates/`）
4. 状态：`pending`

### 看候选列表

```bash
openclaw-learn status
# 显示当前所有 candidates 的状态分布
# pending / reviewing / validating / graduated / retired / rejected
```

### 看单个候选

```bash
openclaw-learn status <candidate-id-prefix>
# 例如：openclaw-learn status sha256:abc123
```

### 审查（Review Gate）

```bash
openclaw-learn review --candidate <id>
# 跑四维 Review：metadata / safety / conflict / semantic
# 任一维度失败即 reject
```

### 影子观察（Shadow Trial）

```bash
# 进入 validating 阶段后自动开始（默认 7 天观察）
openclaw-learn audit --candidate <id>
# 看 trial 日志
```

### 毕业（Graduation）

```bash
openclaw-learn override --candidate <id> --action force_graduate
# 强制毕业（生产环境会自动毕业，这只是手动接管）
```

### 看配置

```bash
openclaw-learn config show
# 看当前 config.yaml 合并后的值
```

### 重新加载配置

```bash
openclaw-learn config reload
```

---

## 自动化（cron）

让它每天凌晨自动跑：

```bash
bash scripts/register-cron.sh
# 默认在 cron 4:30 触发 daily-reflect.sh
# OpenClaw 环境用 `openclaw cron add`，其他用 crontab
```

错峰逻辑：03:00-03:59 自动跳过（避免和 OpenClaw 自身的 daily memory consolidation 撞车）。

Token 预算保护：超过 `daily_token_budget`（默认 50000）会自动跳过。

---

## 配置

`~/.openclaw/workspace/learn/config.yaml` 是用户配置：

```yaml
# 关键字段
reflection:
  daily_token_budget: 50000          # 每日 LLM token 上限
  llm:
    provider: openclaw                # openclaw（推荐）/ openai-compatible
    model: github-copilot/claude-haiku-4.5  # 默认廉价模型
    temperature: 0.3
    max_tokens: 2000

shadow:
  observation_days: 7                 # 影子观察期
  min_trials: 5                       # 最少观察次数才能毕业
  conflict_threshold: 0.3             # 冲突容忍度
```

完整选项见 `references/customization.md`。

---

## 卸载

```bash
bash scripts/uninstall.sh --force
# 清 skill 注册 + CLI（保留数据）

bash scripts/uninstall.sh --force --no-keep-data
# 全清（含 SQLite + audit log）
```

---

## 出问题怎么办

### 问题 1：`openclaw skills list` 看不到 self-learning-loop

```bash
# 看 OpenClaw 日志
openclaw skills check 2>&1 | grep self-learning-loop
```

如果报 `symlink-escape`：你装的是旧版（v1.1.0-alpha.1 之前），重装一遍：

```bash
bash scripts/uninstall.sh --force
git pull && npm run build
bash scripts/setup.sh --mode local
```

### 问题 2：`openclaw-learn status` 报 candidate store not found

如果你 cd 到非 OpenClaw workspace 跑，应该能自动找到。如果还不行：

```bash
LEARNING_LOOP_WORKSPACE=~/.openclaw/workspace openclaw-learn status
```

### 问题 3：reflect 调 LLM 失败

```bash
openclaw-learn audit --tail 20
# 看最近 audit 日志
```

如果是 token 预算超限：

```bash
bash scripts/check-token-budget.sh
# 看今日已用量
```

可以临时调高 `config.yaml` 的 `daily_token_budget`，或等明天。

### 问题 4：候选不毕业

很可能是影子观察期没满（默认 7 天）或 trials 数不够。手动看：

```bash
openclaw-learn status <candidate-id>
# 看 trial_count 和 ready_at
```

强制毕业：

```bash
openclaw-learn override --candidate <id> --action force_graduate
```

### 问题 5：误毕业了想撤销

```bash
openclaw-learn override revert --candidate <id>
# 回滚 marker block + 状态从 graduated 退回 validating
# audit 写入 graduation_reverted 事件
```

---

## 报 bug 给万三

```bash
# 收集诊断信息
openclaw-learn status > /tmp/learn-status.txt
openclaw-learn audit --tail 50 > /tmp/learn-audit.txt
ls -la ~/.openclaw/workspace/learn/ > /tmp/learn-fs.txt
cat ~/.openclaw/workspace/learn/config.yaml > /tmp/learn-config.txt
```

然后丢给万三让他看。

---

## 当前已知限制（v1.1.0-alpha.1）

- **影子观察统计** 还在 P1b 阶段开发中，validating 状态主要靠人工或时间触发
- **Codex YAML adapter** 已实装（T-SLL-012, tested），配置文件位于 `configs/adapters/codex.yaml`
- **`config show`** 显示 Field / Value / Source 三栏，Source 来源含 default / config-file / env-var / cli-override（T-SLL-006 已实装）
- **E2E 跨 runtime 串测** 还没做（你的真实使用就是最好的 E2E）

---

## 下一步（v1.2 路线图）

- L3/L4 学习层（半自动 + 全自动毕业）
- A/B 测试 metrics-collector
- CI 集成（`openclaw-learn ci-gate`）
- VSCode extension 显示 candidate 状态

---

**有问题随时找万三。先把它跑起来比什么都重要。** 🎯
