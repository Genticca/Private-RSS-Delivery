-- 0001_init.sql — 전체 스키마. 2026-10-17에 이전 0001~0023을 하나로 합쳤고, 2026-10-18에 정리했다(D28).
-- 이후 스키마 변경은 0002_ 부터 새 파일로 추가한다. 테이블·컬럼 의미는 Docs/DB-스키마.md.

-- 소스와 전송 채널 ---------------------------------------------------------

CREATE TABLE templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  body       TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sources (
  id                    TEXT PRIMARY KEY,
  feed_url              TEXT NOT NULL,
  name                  TEXT,
  enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- D12 Provider Profile: 'auto' = 자동 감지, 그 외 = 수동 override
  profile               TEXT NOT NULL DEFAULT 'auto',  -- auto|incident-io|atlassian-statuspage|generic
  detected_profile      TEXT,                          -- 첫 200 응답에서 감지해 저장 (304/빈 본문엔 재감지 금지)

  -- 폴링 lifecycle
  initialized           INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
  delivery_cutoff_at    TEXT,                          -- 이 시각(<published>) 이전 항목은 전송 안 함
  etag                  TEXT,
  last_modified         TEXT,
  last_polled_at        TEXT,
  next_poll_at          TEXT,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (poll_interval_seconds > 0),
  fetch_options         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fetch_options)),
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,

  template_id           INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  translate             INTEGER NOT NULL DEFAULT 0 CHECK (translate IN (0, 1)),
  webhook_name          TEXT,                          -- 그룹 웹훅에 얹는 표시 이름 override (웹훅 URL은 groups 소유)
  webhook_avatar_url    TEXT,

  -- D22 메시지 옵션
  silent                INTEGER NOT NULL DEFAULT 0 CHECK (silent IN (0, 1)),
  mention_role_ids      TEXT CHECK (json_valid(mention_role_ids)),
  mention_user_ids      TEXT CHECK (json_valid(mention_user_ids)),
  mention_everyone      INTEGER NOT NULL DEFAULT 0 CHECK (mention_everyone IN (0, 1)),
  mention_here          INTEGER NOT NULL DEFAULT 0 CHECK (mention_here IN (0, 1)),
  thread_id             TEXT,
  thread_name           TEXT,
  applied_tags          TEXT CHECK (json_valid(applied_tags)),
  edit_in_place         INTEGER NOT NULL DEFAULT 0 CHECK (edit_in_place IN (0, 1)),

  config_revision       INTEGER NOT NULL DEFAULT 1,   -- 발송에 영향을 주는 설정이 바뀔 때마다 +1 (트리거)
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
-- 발송 상태는 delivery_jobs·item_deliveries에만 둔다. 항목은 내용과 버전만 가진다.

CREATE TABLE items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id        TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  atom_id          TEXT NOT NULL,                      -- D11: Atom <id> 통째를 식별 키로
  title            TEXT,
  summary          TEXT,                               -- incident 모드: 최신 segment
  link             TEXT NOT NULL DEFAULT '',
  author           TEXT,
  comments_url     TEXT,
  image            TEXT,
  incident_stage   TEXT,
  published_at     TEXT,                               -- Atom <published> → cutoff 판정
  updated_at       TEXT,                               -- Atom <updated>
  content_hash     TEXT NOT NULL,                      -- 변경 감지 (identity 와 분리)
  content_revision INTEGER NOT NULL DEFAULT 1,         -- content_hash가 바뀔 때마다 +1. 메시지 수정의 기준
  historical       INTEGER NOT NULL DEFAULT 0 CHECK (historical IN (0, 1)),  -- 수집 당시 발송 대상이 아니었던 항목
  content_pruned   INTEGER NOT NULL DEFAULT 0 CHECK (content_pruned IN (0, 1)),
  last_seen_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source_id, atom_id)                          -- source_id 조회도 이 인덱스로 처리
);

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
  binding_id INTEGER NOT NULL REFERENCES delivery_bindings(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK(operation IN ('initial_post','edit','update_post')),
  revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN
    ('pending','running','succeeded','failed','cancelled','held','unknown','uneditable')),
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
  UNIQUE (item_id, binding_id, operation, revision)
);
CREATE UNIQUE INDEX idx_initial_job ON delivery_jobs(item_id, binding_id) WHERE operation = 'initial_post';
CREATE INDEX idx_delivery_jobs_due ON delivery_jobs(state, next_attempt_at, id);
CREATE INDEX idx_delivery_jobs_binding ON delivery_jobs(binding_id, item_id, state);
CREATE UNIQUE INDEX idx_delivery_job_running ON delivery_jobs(item_id, binding_id) WHERE state = 'running';

CREATE TABLE destination_cooldowns (
  bucket_key TEXT PRIMARY KEY,
  until_at TEXT NOT NULL
);

-- 번역 캐시 ------------------------------------------------------------------
-- 모델 이름과 API 키는 환경 변수(GEMINI_MODEL, PRIMARY_MODEL_API_KEY)에서 읽는다.

CREATE TABLE translation_cache (
  cache_key TEXT PRIMARY KEY,
  field TEXT NOT NULL CHECK(field IN ('title','summary')),
  status TEXT NOT NULL CHECK(status IN ('success','failed')),
  value TEXT,
  last_error TEXT,
  retry_after TEXT,
  updated_at TEXT NOT NULL
);

-- 운영 로그 ------------------------------------------------------------------
-- 수집·발송·번역 결과를 한 테이블에 남긴다. 보존 기간이 지나면 cleanup이 지운다.

CREATE TABLE event_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('fetch', 'delivery', 'translation')),
  status      TEXT NOT NULL CHECK (
       (kind = 'fetch'       AND status IN ('ok', 'not_modified', 'error'))
    OR (kind = 'delivery'    AND status IN ('success', 'failed'))
    OR (kind = 'translation' AND status IN ('success', 'failed', 'cache_hit', 'skipped'))),
  source_id   TEXT REFERENCES sources(id) ON DELETE CASCADE,
  item_id     INTEGER,
  job_id      INTEGER,                                 -- 목적지와 작업 종류(발송/수정)는 작업에서 조회
  http_status INTEGER,
  duration_ms INTEGER,
  item_count  INTEGER,                                 -- fetch: 새로 발송 대상이 된 항목 수
  detail      TEXT                                     -- 오류 내용 또는 짧은 요약
);
CREATE INDEX idx_event_log_kind ON event_log(kind, id DESC);
CREATE INDEX idx_event_log_source ON event_log(source_id, kind, id DESC);
