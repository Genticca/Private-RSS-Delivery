-- 0002_templates.sql — Discord payload template storage + source runtime fields.

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  body       TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE sources ADD COLUMN template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL;
ALTER TABLE sources ADD COLUMN webhook_url TEXT;
ALTER TABLE sources ADD COLUMN poll_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (poll_interval_seconds > 0);
ALTER TABLE sources ADD COLUMN fetch_options TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fetch_options));
ALTER TABLE sources ADD COLUMN translate INTEGER NOT NULL DEFAULT 0 CHECK (translate IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_sources_template_id ON sources(template_id);
CREATE INDEX IF NOT EXISTS idx_templates_builtin_name ON templates(is_builtin, name);
