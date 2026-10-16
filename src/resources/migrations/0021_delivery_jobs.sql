ALTER TABLE items ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE items ADD COLUMN last_seen_at TEXT;
ALTER TABLE items ADD COLUMN content_pruned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER sources_config_revision AFTER UPDATE OF feed_url, profile, enabled, thread_id, thread_name,
  applied_tags, template_id, translate, silent, mention_role_ids, mention_user_ids, mention_everyone,
  mention_here, webhook_name, webhook_avatar_url, edit_in_place ON sources
BEGIN
  UPDATE sources SET config_revision = config_revision + 1 WHERE id = NEW.id;
END;
CREATE TRIGGER source_groups_config_insert AFTER INSERT ON source_groups BEGIN
  UPDATE sources SET config_revision = config_revision + 1 WHERE id = NEW.source_id;
END;
CREATE TRIGGER source_groups_config_delete AFTER DELETE ON source_groups BEGIN
  UPDATE sources SET config_revision = config_revision + 1 WHERE id = OLD.source_id;
END;
CREATE TRIGGER groups_config_update AFTER UPDATE OF webhook_url ON "groups" BEGIN
  UPDATE sources SET config_revision = config_revision + 1
    WHERE id IN (SELECT source_id FROM source_groups WHERE group_id = NEW.id);
END;

CREATE TABLE delivery_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  destination_key TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  ended_at TEXT,
  baseline_item_id INTEGER,
  baseline_at TEXT
);
CREATE UNIQUE INDEX idx_bindings_active ON delivery_bindings(source_id, destination_key) WHERE ended_at IS NULL;

CREATE TABLE item_deliveries (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  binding_id INTEGER NOT NULL REFERENCES delivery_bindings(id) ON DELETE CASCADE,
  message_id TEXT,
  channel_id TEXT,
  thread_id TEXT,
  applied_revision INTEGER NOT NULL DEFAULT 0,
  first_delivered_at TEXT NOT NULL,
  PRIMARY KEY (item_id, binding_id)
);

CREATE TABLE delivery_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  binding_id INTEGER REFERENCES delivery_bindings(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK(operation IN ('initial_post','edit','update_post')),
  revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN
    ('pending','running','succeeded','failed','cancelled','held','unknown','legacy_unknown','uneditable')),
  item_snapshot TEXT NOT NULL,
  source_snapshot TEXT NOT NULL,
  template_body TEXT NOT NULL,
  payload TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  claim_token TEXT,
  request_started_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (item_id, binding_id, operation, revision),
  CHECK(binding_id IS NOT NULL OR state IN ('legacy_unknown','cancelled'))
);
CREATE UNIQUE INDEX idx_initial_job ON delivery_jobs(item_id, binding_id) WHERE operation = 'initial_post' AND binding_id IS NOT NULL;
CREATE UNIQUE INDEX idx_legacy_unknown ON delivery_jobs(item_id) WHERE state = 'legacy_unknown';
CREATE INDEX idx_delivery_jobs_due ON delivery_jobs(state, next_attempt_at, id);
CREATE INDEX idx_delivery_jobs_binding ON delivery_jobs(binding_id, item_id, state);
CREATE UNIQUE INDEX idx_delivery_job_running ON delivery_jobs(item_id, binding_id) WHERE state = 'running';

CREATE TABLE destination_cooldowns (
  bucket_key TEXT PRIMARY KEY,
  until_at TEXT NOT NULL
);

INSERT INTO delivery_jobs (item_id, operation, revision, state, item_snapshot, source_snapshot, template_body, error, created_at)
  SELECT id, 'initial_post', content_revision, 'legacy_unknown', '{}', '{}', '', 'Original destination cannot be proven.',
    strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM items WHERE delivery_status IN ('pending','failed');
UPDATE items SET delivery_status = 'failed', next_attempt_at = NULL, failure_reason = 'legacy_unknown'
  WHERE delivery_status IN ('pending','failed');
UPDATE items SET translated_title = NULL, translated_summary = NULL, translated_at = NULL;
