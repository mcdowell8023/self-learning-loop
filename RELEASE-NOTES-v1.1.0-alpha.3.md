# v1.1.0-alpha.3 — Bug Fixes + Reporter Hook

发布日期: 2026-04-27
Previous: v1.1.0-alpha.2

## 概要

修复 alpha.2 部署暴露的 2 个安装阻塞 bug，新增事件钩子机制为 reporter skill 集成铺路。

## 修复

### Bug #1：路径不一致（P0）
- `setup.sh` 的 `get_init_workspace("openclaw")` 返回 `~/.openclaw/workspace`（之前错误返回 `~/.openclaw`）
- CLI `workspace-resolver.ts` 自动探测路径同步修正
- Config loader 默认用户配置路径对齐到 `~/.openclaw/workspace/learn/config.yaml`

### Bug #2：cron 签名过期（P1）
- `register-cron.sh` 从已废弃的 `--every/--at` 更新为 `--name/--cron` 新签名
- 默认调度时间从 04:30 → 07:00（避免凌晨过早噪音）

## 新增

### 事件落盘
- reflect 完成后写入 `<workspace>/learn/events/reflection-completed.json`
- Atomic write（先写 `.tmp` 再 rename），失败也记录
- 包含反思摘要、候选状态总览、高 confidence 候选列表

### Reporter 钩子
- reflect 完成后自动探测 `learning-loop-reporter` skill
- 存在 → 调用 `learning-loop-reporter notify --event <path>`
- 不存在 → 静默跳过 + audit 日志记录
- reporter 失败不影响 reflect 主流程（解耦设计）

## 删除
- `scripts/daily-reflect-and-report.sh`（作废的 wrapper 方案）

## 升级指引

```bash
cd ~/open-claw-output/code/learning-loop
git pull
bash scripts/setup.sh --runtime openclaw

# 如果之前已有 ~/.openclaw/learn/，需要迁移：
mv ~/.openclaw/learn ~/.openclaw/workspace/learn
```
