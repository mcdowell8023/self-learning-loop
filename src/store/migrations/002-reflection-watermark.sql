-- Reflection watermark + dedup table (incremental reflect support)

CREATE TABLE IF NOT EXISTS reflection_watermark (
  key            TEXT PRIMARY KEY DEFAULT 'default',
  last_processed_date TEXT NOT NULL,  -- YYYY-MM-DD
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reflection_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT NOT NULL,       -- YYYY-MM-DD
  source_hash    TEXT NOT NULL,       -- sha256 of source content
  candidates_count INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  UNIQUE(date, source_hash)
);
