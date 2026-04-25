-- src/store/migrations/001-init.sql
-- Candidate Store schema (§5.2.4 v5.0.3)
--
-- 双表设计：
--   * strategies — Strategy 模板（可复用经验）
--   * instances  — Strategy 的具体应用实例（一对多）
-- 另加一张 candidate_state 表记录 Candidate 生命周期（state + dormant_reason），
-- 与 strategy_id 一一对应（candidate_id === strategy_id）。

PRAGMA foreign_keys = ON;

-- ============================================================
-- strategies：策略模板
-- ============================================================
CREATE TABLE IF NOT EXISTS strategies (
  strategy_id        TEXT PRIMARY KEY,
  problem_category   TEXT NOT NULL,
  trigger_conditions TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  scope              TEXT NOT NULL,        -- 'general' | 'tool:<x>' | 'role:<x>' | 'skill'
  tags               TEXT,                 -- JSON array
  data               TEXT NOT NULL,        -- 完整 Strategy JSON（兼容未来字段扩展）
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strategies_problem_category ON strategies(problem_category);
CREATE INDEX IF NOT EXISTS idx_strategies_scope            ON strategies(scope);

-- ============================================================
-- instances：具体应用实例
-- ============================================================
CREATE TABLE IF NOT EXISTS instances (
  instance_id   TEXT PRIMARY KEY,
  strategy_id   TEXT NOT NULL,
  diff_summary  TEXT NOT NULL,
  runtime       TEXT NOT NULL,             -- env_fingerprint.runtime
  data          TEXT NOT NULL,             -- 完整 Instance JSON
  created_at    TEXT NOT NULL,
  FOREIGN KEY (strategy_id) REFERENCES strategies(strategy_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_instances_strategy_id ON instances(strategy_id);
CREATE INDEX IF NOT EXISTS idx_instances_runtime     ON instances(runtime);

-- ============================================================
-- candidate_state：Candidate 生命周期（8 态状态机 + dormant_reason）
-- candidate_id === strategy_id
-- ============================================================
CREATE TABLE IF NOT EXISTS candidate_state (
  candidate_id   TEXT PRIMARY KEY,
  strategy_id    TEXT NOT NULL UNIQUE,
  state          TEXT NOT NULL DEFAULT 'pending',
  dormant_reason TEXT,                     -- 'no_match' | 'inconclusive' | NULL
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY (strategy_id) REFERENCES strategies(strategy_id) ON DELETE CASCADE,
  CHECK (state IN (
    'pending','reviewing','validating','conflict',
    'graduated','retired','dormant','rejected'
  )),
  CHECK (
    (state = 'dormant' AND dormant_reason IN ('no_match','inconclusive'))
    OR
    (state <> 'dormant' AND dormant_reason IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_candidate_state_state          ON candidate_state(state);
CREATE INDEX IF NOT EXISTS idx_candidate_state_dormant_reason ON candidate_state(dormant_reason);

-- ============================================================
-- state_transitions：状态转移审计日志（append-only）
-- ============================================================
CREATE TABLE IF NOT EXISTS state_transitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id  TEXT NOT NULL,
  from_state    TEXT NOT NULL,
  to_state      TEXT NOT NULL,
  action        TEXT NOT NULL,
  actor         TEXT NOT NULL,             -- 'system' | 'user'
  dormant_reason TEXT,                     -- 进入 dormant 时记录
  transitioned_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES candidate_state(candidate_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_state_transitions_candidate ON state_transitions(candidate_id);
