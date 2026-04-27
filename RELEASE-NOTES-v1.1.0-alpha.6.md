# v1.1.0-alpha.6 — Reporter CLI Alignment

发布日期: 2026-04-27
Previous: v1.1.0-alpha.5

## 概要

对齐 `learning-loop-reporter` v0.5.0 新 CLI，清理 self-learning-loop 中遗留的 `notify --event` 调用，避免 reflect 结束后继续使用已废弃参数。

## 修复

### Reporter 调用参数升级
- `src/cli/reflect.ts` 从 `learning-loop-reporter notify --event <path>` 改为 `learning-loop-reporter notify --report <daily-report-path>`
- reporter 审计事件补充 `report_path`，便于排查发送目标
- reflect 成功日志会展示实际传给 reporter 的日报路径

### 文档残留清理
- `RELEASE-NOTES-v1.1.0-alpha.3.md` 中 reporter 用法示例同步更新为 `notify --report`
- 仓库内 legacy `--event` 调用点清理完毕（源码 / 文档 / 构建产物重建后）

## 测试

- 新增回归测试：`buildReporterNotifyArgs()` 断言使用 `--report`
- 新增回归测试：`invokeReporterHook()` 通过假 reporter 捕获实参，验证不再传 `--event`
- 全量 `npm test` 通过

## 升级指引

```bash
cd ~/open-claw-output/code/learning-loop
npm install
npm run build
openclaw-learn reflect --reason manual --verbose
```

预期：reflect 完成后，reporter 被调用时应携带 `--report <daily-report-path>`，不再出现 `--event`。
