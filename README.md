# @openclaw/self-learning-loop (v1.1)

OpenClaw Self-Learning Loop — v1.1. Reflects on daily diary notes, generates improvement candidates, and manages their lifecycle.

## Installation

```bash
git clone https://github.com/openclaw/self-learning-loop
cd self-learning-loop && npm install && npm run build
bash scripts/setup.sh --mode local
```

**Install modes:**

| Mode | Command | Description |
|------|---------|-------------|
| `local` (default) | `--mode local` | Symlink to `~/.openclaw/workspace/skills/` |
| `global` | `--mode global` | Symlink to `~/.local/share/openclaw-learn/` (multi-runtime) |
| `npm` | `--mode npm` | `npm link` for development |

Use `--dry-run` to preview actions without making changes. Use `--runtime <name>` to target a specific runtime (`openclaw`, `claude-code`, `opencode`, `codex`).

To uninstall:

```bash
bash scripts/uninstall.sh
```

## Quick Start

```bash
npm run build

# Initialize workspace (creates learn/ with SQLite DB + config)
node dist/cli/learn.js init --workspace ~/.openclaw/workspace

# Run reflection (incremental, from watermark to yesterday)
node dist/cli/learn.js reflect --workspace ~/.openclaw/workspace

# Reflect on today's diary
node dist/cli/learn.js reflect --today

# Reflect on specific date range
node dist/cli/learn.js reflect --from 2026-04-20 --to 2026-04-24

# Reflect on a specific file (bypasses incremental)
node dist/cli/learn.js reflect --source ~/.openclaw/workspace/memory/2026-04-22.md --dry-run

# Check candidate status
node dist/cli/learn.js status
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Initialize `learn/` workspace (SQLite + config.yaml + audit/) |
| `reflect` | Run reflection pass — analyzes memory files, generates candidates |
| `status [id]` | List candidates or show single candidate details |
| `override <sub>` | Force-graduate / force-retire a candidate |
| `config reload` | Hot-reload config.yaml |

## Incremental Reflection

`reflect` tracks a **watermark** (last processed date) in SQLite. By default:
- Processes from `watermark + 1` to yesterday
- Skips dates whose content hasn't changed (sha256 dedup)
- `--from` / `--to` overrides the watermark for forced re-processing
- `--today` is a shortcut for reflecting on today's diary

## 万三口令映射

万三接到以下口令时，自动触发反思：

| 口令 | 映射命令 |
|------|---------|
| `反思下` | `learning-loop reflect --today` |
| `/reflect` | `learning-loop reflect --today` |
| `反思 YYYY-MM-DD` | `learning-loop reflect --from YYYY-MM-DD --to YYYY-MM-DD` |
| `全量反思` | `learning-loop reflect --from 2026-04-01` (从最早日记开始) |

## Cron 自动化

每天自动反思昨天的日记：

```bash
# 注册到 OpenClaw cron（万三手动执行）：
openclaw cron add --name "daily-reflect" --every 24h --at "06:00" --command "bash ~/open-claw-output/code/learning-loop/scripts/daily-reflect.sh"
```

日志输出到：`~/open-claw-output/logs/learning-loop-reflect-YYYY-MM-DD.log`

## Development

```bash
npm run build      # TypeScript compile + copy migrations
npm test           # Run all tests (vitest)
npm run test:watch # Watch mode
```

## Environment Variables

- `POLLINATIONS_API_KEY` — Required for LLM calls during reflection
