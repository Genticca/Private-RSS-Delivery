-- 0004_fetch_log.sql — Feed poll result counters and diagnostics.

CREATE TABLE IF NOT EXISTS fetch_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  outcome          TEXT NOT NULL CHECK (outcome IN ('200', '304', 'error')),
  http_status      INTEGER,
  items_new        INTEGER NOT NULL DEFAULT 0 CHECK (items_new >= 0),
  items_historical INTEGER NOT NULL DEFAULT 0 CHECK (items_historical >= 0),
  items_changed    INTEGER NOT NULL DEFAULT 0 CHECK (items_changed >= 0),
  items_skipped    INTEGER NOT NULL DEFAULT 0 CHECK (items_skipped >= 0),
  duration_ms      INTEGER,
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fetch_log_source_created ON fetch_log(source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fetch_log_created ON fetch_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fetch_log_outcome_created ON fetch_log(outcome, created_at DESC);
