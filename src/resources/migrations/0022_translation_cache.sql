CREATE TABLE translation_cache (
  cache_key TEXT PRIMARY KEY,
  field TEXT NOT NULL CHECK(field IN ('title','summary')),
  status TEXT NOT NULL CHECK(status IN ('success','failed')),
  value TEXT,
  last_error TEXT,
  retry_after TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE translation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  item_id INTEGER,
  job_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_translation_events_created ON translation_events(created_at);
ALTER TABLE model_usage ADD COLUMN http_requested INTEGER NOT NULL DEFAULT 1;
ALTER TABLE model_usage ADD COLUMN item_id INTEGER;
ALTER TABLE model_usage ADD COLUMN job_id INTEGER;
UPDATE model_usage SET http_requested = 0 WHERE error IN ('disabled','missing-key');
