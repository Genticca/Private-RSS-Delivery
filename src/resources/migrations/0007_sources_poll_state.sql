-- 0007_sources_poll_state.sql — DB-authoritative polling state.

ALTER TABLE sources ADD COLUMN last_polled_at TEXT;
ALTER TABLE sources ADD COLUMN next_poll_at TEXT;

CREATE INDEX IF NOT EXISTS idx_sources_enabled_next_poll ON sources(enabled, next_poll_at);
