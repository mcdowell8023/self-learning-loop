# v1.1.0-alpha.2 — Cross-runtime Foundation

发布日期: 2026-04-26
Previous: v1.1.0-alpha.1

## 🎯 本版重点
跨 runtime 安装能力打通，Codex 完整支持，配置可视化。

## ✨ 新增能力 (P1)

### T-SLL-005: setup.sh 强化
- 4 runtime auto-detect (openclaw / claude-code / opencode / codex)
- 权限预检 + ERR trap 自动回滚
- 完整 34 条隔离测试

### T-SLL-006: Config schema 扩展 + `config show`
- 新字段：runtime / paths / triggers
- `${HOME}` 环境变量插值
- 三栏命令：Field / Value / Source（含 default / config-file / env-var / cli-override 来源追踪）
- `--format json|table` / `--key <path>` 支持

### T-SLL-012: Codex 支持
- GenericAdapter + YAML 模板模式
- 内置 `configs/adapters/codex.yaml`
- 支持 transforms (role_map / timestamp_format / part_type)
- 四级 discovery chain（env / package dir / cwd / source fallback）
- 完整文档：`references/adapters.md`

## 🔧 修复 (Blocker B1-B6)

- **B1**: TS2322 build error in generic.ts
- **B2**: Codex adapter 跨 runtime 路径解析
- **B3**: node_modules 从 git 历史清除
- **B4**: uninstall 选项与文档一致性
- **B5**: uninstall 完整性（覆盖 4 runtime + CLI + data_dir + legacy 路径，含防呆）
- **B6**: 目录语义统一为 `~/.openclaw/learn`

## 📚 文档 / DX
- README 加 Prerequisites（Node ≥ 20）
- README 加 Cross-runtime Install / Configuration Inspection 段落
- QUICKSTART 路径全部统一为 `~/.openclaw/learn`
- runtime-integration.md 路径修正
- `npm run verify` = build && test 一键检验

## 🧪 测试基线
- npm test: **416/416**（基线 390 → +26 新增）
- setup.test.sh: 34/34
- codex-install.test.sh: PASS（B2 关键验证）
- uninstall-e2e.test.sh: 24/24（B5 防回归）

## 🚧 已知问题 / 后续
- v1.2 计划：OpencodeAdapter SQLite 实测对齐 / Dreaming 整合 (T-INT P0)
- 详见 TODO.md

## 升级提示
- 从 alpha.1 升级：rerun `bash scripts/setup.sh --mode local` 即可
- 从更早版本：先 `bash scripts/uninstall.sh` 再重装

## Commits
- `6ba3134` T-SLL-005: setup.sh harden
- `37d715b` T-SLL-012: Codex adapter
- `40743b5` T-SLL-006: config schema + show
- `17db280` fix: B1-B3 + M1 + S1
- `f0c62fa` fix: B4-B6 uninstall + directory semantics
- `28f60de` chore: alpha.2 release notes + doc fixes
