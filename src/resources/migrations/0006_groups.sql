-- 0006_groups.sql — Shared Discord destinations and source-group membership.

CREATE TABLE IF NOT EXISTS "groups" (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  webhook_url        TEXT,
  webhook_name       TEXT,
  webhook_avatar_url TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source_groups (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  group_id  INTEGER NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, group_id)
);

ALTER TABLE sources ADD COLUMN webhook_name TEXT;
ALTER TABLE sources ADD COLUMN webhook_avatar_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name_nocase ON "groups"(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_source_groups_group ON source_groups(group_id);
