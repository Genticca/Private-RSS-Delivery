-- 0001_init.sql — 전체 스키마. 2026-10-17에 이전 0001~0023을 하나로 합쳤다(결과 스키마 동일).
-- 이후 스키마 변경은 0002_ 부터 새 파일로 추가한다. 테이블·컬럼 의미는 Docs/db-schema.md.

-- 소스와 전송 채널 ---------------------------------------------------------

CREATE TABLE templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  body       TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sources (
  id                    TEXT PRIMARY KEY,
  feed_url              TEXT NOT NULL,
  name                  TEXT,
  enabled               INTEGER NOT NULL DEFAULT 1,

  -- D12 Provider Profile: 'auto' = 자동 감지, 그 외 = 수동 override
  profile               TEXT NOT NULL DEFAULT 'auto',  -- auto|incident-io|atlassian-statuspage|generic
  detected_profile      TEXT,                          -- 첫 200 응답에서 감지해 저장 (304/빈 본문엔 재감지 금지)

  -- 폴링 lifecycle
  initialized           INTEGER NOT NULL DEFAULT 0,
  delivery_cutoff_at    TEXT,                          -- 이 시각(<published>) 이전 항목은 전송 안 함
  etag                  TEXT,
  last_modified         TEXT,

  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  template_id           INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  webhook_url           TEXT,                          -- D24 이후 사용 안 함(항상 NULL). 웹훅 URL은 groups 소유
  poll_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (poll_interval_seconds > 0),
  fetch_options         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fetch_options)),
  translate             INTEGER NOT NULL DEFAULT 0 CHECK (translate IN (0, 1)),
  webhook_name          TEXT,                          -- 그룹 웹훅에 얹는 표시 이름 override
  webhook_avatar_url    TEXT,
  last_polled_at        TEXT,
  next_poll_at          TEXT,

  -- D22 메시지 옵션
  silent                INTEGER NOT NULL DEFAULT 0,
  mention_role_ids      TEXT,
  mention_user_ids      TEXT,
  mention_everyone      INTEGER NOT NULL DEFAULT 0,
  thread_id             TEXT,
  thread_name           TEXT,
  applied_tags          TEXT,
  edit_in_place         INTEGER NOT NULL DEFAULT 0,
  mention_here          INTEGER NOT NULL DEFAULT 0,

  config_revision       INTEGER NOT NULL DEFAULT 1,   -- 발송에 영향을 주는 설정이 바뀔 때마다 +1 (트리거)
  consecutive_failures  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_sources_template_id ON sources(template_id);
CREATE INDEX idx_sources_enabled_next_poll ON sources(enabled, next_poll_at);
CREATE UNIQUE INDEX idx_sources_feed_url_unique ON sources(feed_url);
CREATE INDEX idx_templates_builtin_name ON templates(is_builtin, name);

CREATE TABLE "groups" (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  webhook_url        TEXT,
  webhook_name       TEXT,
  webhook_avatar_url TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE source_groups (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  group_id  INTEGER NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, group_id)
);

CREATE UNIQUE INDEX idx_groups_name_nocase ON "groups"(name COLLATE NOCASE);
CREATE INDEX idx_source_groups_group ON source_groups(group_id);

-- 설정 버전: poll 커밋 시 비교해 도중에 바뀐 설정의 결과를 버린다.
CREATE TRIGGER sources_config_revision AFTER UPDATE OF feed_url, profile, enabled, thread_id, thread_name,
  applied_tags, template_id, translate, silent, mention_role_ids, mention_user_ids, mention_everyone,
  mention_here, webhook_name, webhook_avatar_url, edit_in_place, fetch_options, poll_interval_seconds ON sources
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

-- 수집한 항목 ---------------------------------------------------------------

CREATE TABLE items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,

  -- D11: Atom <id> 통째를 식별 키로 (형식 무관, 미지 vendor 자동 처리)
  atom_id            TEXT NOT NULL,

  title              TEXT,
  summary            TEXT,                             -- incident 모드: 최신 segment
  content_hash       TEXT,                             -- 변경 감지 (identity 와 분리)
  incident_stage     TEXT,

  published_at       TEXT,                             -- Atom <published> → cutoff 판정
  updated_at         TEXT,                             -- Atom <updated>

  delivered_at       TEXT,
  next_attempt_at    TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  link               TEXT NOT NULL DEFAULT '',
  author             TEXT,
  comments_url       TEXT,
  image              TEXT,
  delivery_status    TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'historical')),
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failed_at          TEXT,
  failure_reason     TEXT,
  translated_title   TEXT,
  translated_summary TEXT,
  translated_at      TEXT,
  content_revision   INTEGER NOT NULL DEFAULT 1,       -- content_hash가 바뀔 때마다 +1
  last_seen_at       TEXT,
  content_pruned     INTEGER NOT NULL DEFAULT 0,

  UNIQUE (source_id, atom_id)
);

CREATE INDEX idx_items_source ON items(source_id);
CREATE INDEX idx_items_pending_next_attempt
  ON items(next_attempt_at)
  WHERE delivery_status = 'pending';

-- 발송 연결·작업 (D25) -------------------------------------------------------

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

-- 로그 -----------------------------------------------------------------------

CREATE TABLE delivery_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id            INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  attempt_no         INTEGER NOT NULL CHECK (attempt_no > 0),
  status             TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
  http_status        INTEGER,
  error              TEXT,
  rendered_bytes     INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  destination_key    TEXT,
  content_hash       TEXT,
  failure_reason     TEXT,
  discord_message_id TEXT
);

CREATE INDEX idx_delivery_log_item_created ON delivery_log(item_id, created_at DESC);
CREATE INDEX idx_delivery_log_created ON delivery_log(created_at DESC);
CREATE INDEX idx_delivery_log_status_created ON delivery_log(status, created_at DESC);
CREATE INDEX idx_delivery_log_resolution
  ON delivery_log(item_id, destination_key, content_hash, status, failure_reason);
CREATE INDEX idx_delivery_log_message ON delivery_log(item_id, destination_key);

CREATE TABLE fetch_log (
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

CREATE INDEX idx_fetch_log_source_created ON fetch_log(source_id, created_at DESC);
CREATE INDEX idx_fetch_log_created ON fetch_log(created_at DESC);
CREATE INDEX idx_fetch_log_outcome_created ON fetch_log(outcome, created_at DESC);

-- 번역 -----------------------------------------------------------------------

CREATE TABLE model_config (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  role                 TEXT NOT NULL UNIQUE CHECK (role IN ('primary', 'fallback')),
  provider             TEXT NOT NULL CHECK (provider IN ('gemini', 'nvidia-nim')),
  model                TEXT NOT NULL,
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  target_lang          TEXT NOT NULL DEFAULT 'ko',
  prompt_log_max_bytes INTEGER NOT NULL DEFAULT 32768 CHECK (prompt_log_max_bytes >= 0),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE model_usage (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  role           TEXT NOT NULL CHECK (role IN ('primary', 'fallback')),
  provider       TEXT NOT NULL CHECK (provider IN ('gemini', 'nvidia-nim')),
  model          TEXT NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  latency_ms     INTEGER,
  error          TEXT,
  prompt_log     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  http_requested INTEGER NOT NULL DEFAULT 1,
  item_id        INTEGER,
  job_id         INTEGER
);

CREATE INDEX idx_model_usage_role_created ON model_usage(role, created_at DESC);
CREATE INDEX idx_model_usage_provider_created ON model_usage(provider, created_at DESC);
CREATE INDEX idx_model_usage_created ON model_usage(created_at DESC);

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

-- 기본 모델 설정(번역은 Gemini 하나만 쓴다). 이후 값은 관리 화면 /model 에서 바꾼다.
INSERT INTO model_config (role, provider, model, enabled, created_at, updated_at)
VALUES
  ('primary', 'gemini', 'gemini-3.1-flash-lite', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
