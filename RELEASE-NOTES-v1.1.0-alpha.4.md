# Release Notes: v1.1.0-alpha.4

Rich candidate metadata for reporter integration.

## What's New

### Candidate Summary
- reflect 阶段 LLM 一并产出 `summary` 字段（1-2 句中文人话总结）
- 写入 candidate.json 和 mirror markdown frontmatter
- Prompt 示例已包含 summary 字段

### Trigger Event
- 每条候选携带 `trigger_event: { id, summary }` 元信息
- 供日报展示触发事件上下文

### Dropped 候选详情
- `reflection-completed.json` 新增 `dropped_summary`（按原因类型聚合计数）
- 新增 `dropped_items`（每条 dropped 候选的 id/reason/summary）
- 每次 drop 写入 `candidate_dropped` audit event
- DroppedReason 标准码：`duplicate` | `low_confidence` | `low_signal` | `schema_invalid` | `other`

### New Candidate IDs
- `reflection-completed.json` 新增 `new_candidate_ids` 列表
- reporter 根据此列表加载候选详情

### 兼容性
- 支持 `{"candidates": [...]}` 包装格式（同时兼容纯数组）
- 旧候选无 summary 不影响运行

## Test Results
- 427 tests passed (baseline 423, +4 new alpha.4 tests)
