# @openclaw/self-learning-loop

> Cross-runtime self-learning skill for AI agents.
> Let your AI extract reusable rules from real conversations and graduate them into AGENTS.md / TOOLS.md automatically.

![version](https://img.shields.io/badge/version-1.1.0--alpha.1-blue)
![tests](https://img.shields.io/badge/tests-389%20passing-brightgreen)
![runtimes](https://img.shields.io/badge/runtimes-openclaw%20%7C%20claude--code%20%7C%20opencode%20%7C%20codex-purple)

---

## What & Why

AI agents make the same mistakes over and over because they have no persistent "experience." Each session starts from scratch — lessons learned yesterday are gone today.

**self-learning-loop** fixes this. It automatically extracts candidate rules from your work sessions, runs them through a four-dimension review gate, monitors them in shadow trials, and graduates proven rules into your `AGENTS.md` / `TOOLS.md`. Next session, the agent loads those rules and doesn't repeat the mistake.

Think of it as the **reflect → verify → internalize** cycle that humans do naturally — but automated for your AI agent.

## Quick Start

```bash
# 1. Clone & build
git clone https://github.com/mcdowell8023/learning-loop.git
cd learning-loop && npm install && npm run build

# 2. Install skill (auto-detects OpenClaw / Claude Code / Opencode / Codex)
bash scripts/setup.sh --mode local

# 3. Run your first reflection
openclaw-learn reflect --today

# 4. Check candidate status
openclaw-learn status
```

> **Dry run first?** Add `--dry-run` to `setup.sh` to see what it does without making changes.

## How It Works

```
  Memory/Sessions
        │
        ▼
  ┌───────────┐    LLM extracts
  │  Reflect   │───────────────┐
  └───────────┘                │
                               ▼
                    ┌──────────────────┐
                    │  Candidate Store  │  SQLite + markdown mirror
                    │  (Strategy +      │  learn/candidates/YYYY-MM-DD/
                    │   Instance)        │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │  Review Gate      │  4-dimension check:
                    │  metadata │safety │  metadata, safety,
                    │  conflict│semantic│  conflict, semantic
                    └────────┬─────────┘
                             │ pass
                             ▼
                    ┌──────────────────┐
                    │  Shadow Trial     │  7-day observation
                    │  (validating)     │  min 5 trials
                    └────────┬─────────┘
                             │ pass
                             ▼
                    ┌──────────────────┐
                    │  Graduation       │  Writes marker block
                    │  → AGENTS.md      │  into target file
                    │  → TOOLS.md       │
                    └──────────────────┘
```

**Key concepts:**

- **Strategy** — A reusable rule template (e.g., "always check return types")
- **Instance** — A concrete occurrence that triggered the strategy
- **Review Gate** — Four-dimension automated check before a candidate enters observation
- **Shadow Trial** — Real-world observation period to validate the rule doesn't cause regressions
- **Graduation** — Proven rules get a marker block injected into AGENTS.md / TOOLS.md

**State machine:** `pending → reviewing → validating → graduated` (+ `rejected`, `retired`, `dormant`, `archived`)

## Supported Runtimes

| Runtime | Status | Skill Path |
|---------|--------|------------|
| OpenClaw | ✅ Tested | `~/.openclaw/workspace/skills/self-learning-loop/` |
| Claude Code | ✅ Tested | `~/.claude/skills/self-learning-loop/` |
| Opencode | ✅ Tested | `~/.local/share/opencode/skills/self-learning-loop/` |
| Codex | 🔄 YAML mapping ready, untested | `configs/codex-mapping.yaml` |

`setup.sh` auto-detects available runtimes and installs to all of them.

## CLI Reference

All commands use the `openclaw-learn` binary.

| Command | Description |
|---------|-------------|
| `init` | Initialize learn directory (idempotent, safe to re-run) |
| `reflect --today` | Extract candidates from today's sessions via LLM |
| `status [id-prefix]` | Show candidate status overview or single candidate detail |
| `review --candidate <id>` | Run four-dimension review gate on a candidate |
| `audit [--tail N]` | View audit log entries |
| `override --candidate <id> --action <act>` | Manual state transitions (`force_graduate`, `reject`, `retire`) |
| `override revert --candidate <id>` | Revert a graduation (removes marker block) |
| `config show` | Display merged configuration |
| `repair` | Rebuild markdown mirrors from SQLite |

Global flags: `--workspace <path>`, `--verbose`

Full details: [`references/triggers.md`](references/triggers.md) (includes CLI command catalog and trigger conditions)

## Configuration

User config lives at `~/<workspace>/learn/config.yaml`:

```yaml
reflection:
  daily_token_budget: 50000
  llm:
    provider: openclaw          # or openai-compatible
    model: github-copilot/claude-haiku-4.5
    temperature: 0.3
    max_tokens: 2000

shadow:
  observation_days: 7
  min_trials: 5
  conflict_threshold: 0.3

paths:
  candidates_dir: learn/candidates
```

Full options: [`references/customization.md`](references/customization.md)

## Architecture

```
src/
  reflect/      ← Extract candidates from sessions (LLM integration)
  review/       ← Four-dimension Review Gate
  shadow/       ← Shadow trial observation + statistics
  graduation/   ← AGENTS.md / TOOLS.md marker block writer
  adapters/     ← Cross-runtime abstraction (OpenClawAdapter, GenericAdapter)
  cli/          ← Command-line entry points
  store/        ← SQLite candidate store + markdown mirror

scripts/
  setup.sh      ← Install skill + CLI to detected runtimes
  uninstall.sh  ← Clean removal (--no-keep-data for full wipe)
  daily-reflect.sh    ← Cron-friendly reflect wrapper
  register-cron.sh    ← Register daily cron job
  check-token-budget.sh ← Check today's token usage

references/
  architecture.md     ← Detailed system design
  triggers.md         ← CLI commands + trigger conditions + cron setup
  customization.md    ← All configuration options
  runtime-integration.md ← Runtime adapter details
```

## Automation (Cron)

```bash
bash scripts/register-cron.sh
# Registers daily reflect at 04:30
# Skips 03:00-03:59 to avoid collision with OpenClaw memory consolidation
# Respects daily_token_budget — auto-skips if exceeded
```

## Roadmap

- **v1.1** ✅ Cross-runtime adapters + real LLM reflect + CLI + test suite
- **v1.2** — L3/L4 semi-auto/full-auto graduation + A/B metrics-collector
- **v1.3** — VSCode extension / Web UI for candidate management

## Troubleshooting

Common issues and fixes: [`references/triggers.md`](references/triggers.md)

Quick diagnostics:

```bash
openclaw-learn status            # Candidate overview
openclaw-learn audit --tail 20   # Recent audit events
openclaw skills check 2>&1 | grep self-learning-loop  # Skill registration
```

See also: [QUICKSTART.md](QUICKSTART.md) for a guided walkthrough.

## Contributing

This is a personal project by [mcdowell8023](https://github.com/mcdowell8023).

- **Bug reports:** Open a GitHub issue with `openclaw-learn status` and `audit --tail 20` output
- **Pull requests:** Fork → branch → ensure `npm test` passes (389 tests) → PR
- **Questions:** Open an issue or reach out

## License

[MIT](LICENSE)

## Acknowledgments

- [OpenClaw](https://github.com/nicepkg/openclaw) — AI agent runtime and skill system
- [Anthropic Claude](https://www.anthropic.com/) — LLM backbone
- [Pollinations](https://pollinations.ai/) — Multi-modal AI API
