# Release Notes: v1.1.0-alpha.5

核心修复版：把 reflect 真正变成「能收集今天工作、能自己产出日报」的闭环。

## What changed

### 1) 修复 reflect 采集不到今天事件

alpha.4 的根问题不是候选生成器，而是 **reflect 入口层**：

- 默认增量范围是 `watermark+1 → yesterday`
- 同时只读 `memory/YYYY-MM-DD*.md`

结果就是：
- 今天正在发生的工作不会被采进来
- watermark 也不会推进到今天
- 即使 OpenClaw transcript / learn events / TODO / KnowledgeBase 已经有大量信号，reflect 也看不见

alpha.5 修复为：
- 默认范围改成 `watermark+1 → today`
- 每个日期按 bucket 收集多源事件：
  - `memory/`
  - OpenClaw 主会话 transcripts
  - `learn/events/`
  - `TODO.md` 的 git 变更
  - `KnowledgeBase/ClawFeed/Inbox/`
- reflection_log 的去重 hash 改为基于 **整日收集 bucket**，不再只看 memory markdown

### 2) self-learning-loop 自产 markdown 日报

不再要求必须装 reporter skill 才能“看见结果”。

reflect 完成后会自动写：

```text
~/.openclaw/workspace/learn/reports/YYYY-MM-DD-daily.md
```

特性：
- 标准 Markdown，可被 OpenClaw / Opencode / Claude Code 直接读取
- YAML frontmatter 方便机器处理
- 同日多次 reflect 采用 `Run #N` 追加
- `reflection-completed.json` 新增 `report_path`

### 3) 诊断可见性更好

reflect 运行时会输出每个日期的来源统计，例如：

```text
📦 2026-04-27 — memory 6, openclaw 42, learn_events 8, todo_git 3, knowledge_base 2
```

这样下一次再出现“采集量异常低”时，不用盲猜是哪个 collector 坏了。

## Test results

- **438 tests passed**
- 新增：
  - `src/reports/daily-report-generator.spec.ts`（11 cases）
  - `src/cli/reflect-incremental.spec.ts` 回归覆盖默认读 today

## Event schema changes

`learn/events/reflection-completed.json` 新增：

```json
{
  "report_path": "learn/reports/2026-04-27-daily.md"
}
```

## Upgrade notes

```bash
npm install
npm run build
npm test
```

然后手动验证：

```bash
openclaw-learn reflect --reason manual --verbose
cat ~/.openclaw/workspace/learn/reports/$(date +%F)-daily.md
```
