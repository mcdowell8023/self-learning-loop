# Changelog

All notable changes to @openclaw/self-learning-loop will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0-alpha.1] — 2026-04-25

First public alpha. Complete rewrite from P1a baseline with cross-runtime support.

### Added
- Cross-runtime adapter layer (OpenClaw / Claude Code / Opencode / Codex)
- `OpenClawAdapter` with workspace auto-detection
- `GenericAdapter` + Codex YAML mapping (`configs/codex-mapping.yaml`)
- Real LLM integration in reflect (OpenClaw spawn + OpenAI-compatible providers)
- Token budget protection with configurable daily limit (`daily_token_budget`)
- Audit log events: `reflect_started`, `reflect_completed`, `reflect_skipped_budget`, `mirror_write_failed`
- `openclaw-learn` CLI with 8 commands: init, reflect, status, review, audit, override, config show, repair
- `--workspace` flag and workspace resolver chain (flag > env > detection > cwd-fallback)
- `LEARNING_LOOP_WORKSPACE` and `OPENCLAW_WORKSPACE` environment variable support
- `setup.sh` and `uninstall.sh` with `--mode local|global` and `--dry-run`
- Candidate Store: SQLite database + markdown file mirror (under `learn/candidates/YYYY-MM-DD/`)
- Daily reflect cron registration (`scripts/register-cron.sh`)
- Test suite: 389 passing across 26 test files
- SKILL.md + 4 reference docs (architecture, CLI reference, customization, triggers)
- QUICKSTART.md end-user guide

### Fixed
- **P0:** OpenClaw skills system rejecting symlinks ("symlink-escape") → `setup.sh` local mode now copies `SKILL.md` + `references/` instead of symlinking the whole repo
- **P0:** CLI workspace resolution depending on `process.cwd()` → introduced `workspace-resolver.ts` with priority chain (flag > env > runtime detection > cwd fallback)
- **P0:** Test isolation insufficient (audit/override/e2e tests reading from real `~/.openclaw/workspace/learn/audit/`) → tests now force `LEARNING_LOOP_WORKSPACE=tmpDir`
- **M1:** Stop tracking `dist/` build artifacts; added `.gitignore`
- **P1:** Reflect now auto-writes markdown mirrors (no longer requires manual `repair`)
- **P1:** `init` is now idempotent (re-running returns exit 0 instead of error)

### Changed
- Configuration schema: `reflect.llm` block now supports `provider: openclaw | openai-compatible`

### Known Limitations
- Codex YAML mapping is ready but not field-tested on a real Codex runtime
- Shadow trial statistics (P1b) still in development — `validating` state relies on manual or time-based triggers
- `config show` doesn't display source attribution yet (M2, slated for v1.1.0-beta)
- E2E cross-runtime testing only via real-world usage so far

## [Baseline] — 2026-04-20

Initial P1a candidate store code imported as baseline. Single-runtime (OpenClaw only), no LLM integration, no CLI.
