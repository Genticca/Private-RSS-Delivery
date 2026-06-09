-- 0001_init.sql — 초기 스키마 (D11/D12 반영). 템플릿/로그/모델 테이블은 후속 마이그레이션에서 추가.

CREATE TABLE IF NOT EXISTS sources (
  id                 TEXT PRIMARY KEY,
  feed_url           TEXT NOT NULL,
  name               TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,

  -- D12 Provider Profile: 'auto' = 자동 감지, 그 외 = 수동 override
  profile            TEXT NOT NULL DEFAULT 'auto',  -- auto|incident-io|atlassian-statuspage|generic
  detected_profile   TEXT,                          -- 첫 200 응답에서 감지해 persist (304/빈 본문엔 재감지 금지)

  -- 폴링 lifecycle
  initialized        INTEGER NOT NULL DEFAULT 0,
  delivery_cutoff_at TEXT,                          -- 이 시각(<published>) 이전 incident 는 전송 안 함
  etag               TEXT,
  last_modified      TEXT,

  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,

  -- D11: Atom <id> 통째를 식별 키로 (형식 무관, 미지 vendor 자동 처리)
  atom_id         TEXT NOT NULL,

  title           TEXT,
  summary         TEXT,                             -- incident 모드: 최신 segment
  content_hash    TEXT,                             -- 변경 감지 (identity 와 분리)
  incident_stage  TEXT,

  published_at    TEXT,                             -- Atom <published> → cutoff 판정
  updated_at      TEXT,                             -- Atom <updated>  → 변경 감지 / referenceDate

  delivered_at    TEXT,
  next_attempt_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (source_id, atom_id)
);

CREATE INDEX IF NOT EXISTS idx_items_source ON items(source_id);
