-- 0003_delivery_log.sql — Discord delivery attempts, including retry attempts.

CREATE TABLE IF NOT EXISTS delivery_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  attempt_no     INTEGER NOT NULL CHECK (attempt_no > 0),
  status         TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
  http_status    INTEGER,
  error          TEXT,
  rendered_bytes INTEGER,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_delivery_log_item_created ON delivery_log(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_log_created ON delivery_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delivery_log_status_created ON delivery_log(status, created_at DESC);
