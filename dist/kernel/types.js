// src/kernel/types.ts
//
// Phase 1a 运行时平铺接口（下游 store/review/reflect/shadow 使用）。
// 完整 zod schemas 见 ./schemas/*.ts（T-P1a-001 合并后引入）。
//
// 本文件提供两类导出：
// 1. 原有平铺 interface（Candidate/Strategy/Instance/TrialResult/...）——B 侧下游契约
// 2. 从 ./schemas/ re-export 的新增类型（SessionEvent/SessionRef/AuditEvent/...）
//
// 注意：schemas 里的 `type Candidate`（z.infer，嵌套 data 结构）**不**在本文件 re-export，
// 避免与平铺 Candidate 命名冲突。需要 zod 校验请直接 `from '../kernel/schemas/...'`。
export {};
