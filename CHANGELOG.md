# Changelog

All notable changes to @openclaw/self-learning-loop will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0-alpha.5] — 2026-04-27

Core reflect collection fix + built-in markdown daily reports.

### Fixed
- **Root cause of `events_collected: 1`**: reflect incremental mode previously only loaded `memory/YYYY-MM-DD*.md`, and default range stopped at **yesterday**, so same-day work never entered the pipeline and watermark could not advance to today.
- Default incremental reflect range now runs **watermark+1 → today** instead of stopping at yesterday.
- Added multi-source collection for reflect: workspace memory, OpenClaw transcripts, `learn/events/`, TODO git history, and KnowledgeBase ClawFeed Inbox.
- Reflection dedup / watermark logging now hashes the **full collected source bucket per day**, not just memory markdown content.
- `buildCandidatesSummary()` now reads candidate lifecycle state correctly (`state` instead of stale `status`).

### Added
- Built-in markdown daily report output: `learn/reports/YYYY-MM-DD-daily.md`
- Same-day reflect appends `## Run #N` sections instead of overwriting the daily report.
- `report_path` field in `learn/events/reflection-completed.json`
- `src/reports/daily-report-generator.ts` + 11 report generator tests
- Regression coverage for default-today incremental reflect behavior

### Changed
- Reflect now prints per-source collection counts in verbose / normal run output for easier diagnosis.

## [1.1.0-alpha.4] — 2026-04-27

Rich candidate metadata for reporter integration.

### Added
- **candidate.summary**: 1-2 句中文人话总结，由 reflect LLM 一并产出
- **candidate.trigger_event**: 触发事件元信息（id + summary）
- **dropped_summary**: reflection-completed 事件中按原因类型聚合的 dropped 统计
- **dropped_items**: reflection-completed 事件中每条 dropped 候选的详细信息（id/reason/summary）
- **new_candidate_ids**: reflection-completed 事件中新增候选 ID 列表
- **candidate_dropped** audit event: 每个被丢弃的候选写入 reason/reason_code/reason_detail
- DroppedReason 类型: `duplicate` | `low_confidence` | `low_signal` | `schema_invalid` | `other`
- Prompt 支持 `{"candidates": [...]}` 包装格式（同时兼容纯数组）

### Changed
- reflection-completed event version 升级为 1.1
- Candidate mirror frontmatter 包含 summary / trigger_event

## [1.1.0-alpha.3] — 2026-04-27

Bug fixes + event hook system for reporter integration.

### Fixed
- **Bug #1 路径不一致**: `setup.sh` の `get_init_workspace("openclaw")` 返回 `~/.openclaw/workspace`（之前错误地返回 `~/.openclaw`），CLI workspace-resolver 自动探测路径同步修正
- **Bug #2 cron 签名过期**: `register-cron.sh` 从已废弃的 `--every/--at` 更新为 `--name/--cron` 新签名
- Config loader 默认用户配置路径对齐到 `~/.openclaw/workspace/learn/config.yaml`

### Added
- 事件落盘: reflect 完成后写入 `events/reflection-completed.json`（atomic write，失败也记录）
- Reporter 钩子: reflect 完成后自动探测 `learning-loop-reporter` skill 并调用，不存在时静默跳过
- `findReporterSkill()` 探测链：skills 目录 → `~/.local/bin/` CLI
- `buildCandidatesSummary()` 在事件中包含候选状态总览
- Audit 事件: `reporter_skipped` / `reporter_invoked`

### Changed
- Daily reflect 默认调度时间从 04:30 → 07:00（避免凌晨过早噪音）

### Removed
- 删除作废的 `scripts/daily-reflect-and-report.sh`（错误的 wrapper 思路）

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
- Test suite: 390 passing across 26 test files
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
