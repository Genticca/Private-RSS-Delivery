-- 0015_source_destinations.sql - Add per-source Discord delivery destinations.

CREATE TABLE source_destinations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL DEFAULT 0,
  label              TEXT,
  webhook_url        TEXT NOT NULL,
  webhook_name       TEXT,
  webhook_avatar_url TEXT,
  silent             INTEGER NOT NULL DEFAULT 0,
  mention_everyone   INTEGER NOT NULL DEFAULT 0,
  mention_here       INTEGER NOT NULL DEFAULT 0,
  mention_role_ids   TEXT,
  mention_user_ids   TEXT,
  thread_id          TEXT,
  thread_name        TEXT,
  applied_tags       TEXT
);

CREATE UNIQUE INDEX idx_source_destinations_unique_raw
  ON source_destinations(source_id, webhook_url, thread_id);

CREATE INDEX idx_source_destinations_source_position
  ON source_destinations(source_id, position);

-- Source-owned webhook path: current runtime resolves a source webhook ahead of group webhooks.
-- If the source belongs to groups, blank source name/avatar still falls back to the first group by id.
WITH source_group_candidates AS (
  SELECT
    s.id AS source_id,
    g.webhook_name AS webhook_name,
    g.webhook_avatar_url AS webhook_avatar_url,
    ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY g.id) AS group_rank
  FROM sources s
  JOIN source_groups sg ON sg.source_id = s.id
  JOIN "groups" g ON g.id = sg.group_id
), source_first_group AS (
  SELECT source_id, webhook_name, webhook_avatar_url
  FROM source_group_candidates
  WHERE group_rank = 1
)
INSERT INTO source_destinations (
  source_id, position, webhook_url, webhook_name, webhook_avatar_url,
  silent, mention_everyone, mention_here, mention_role_ids, mention_user_ids,
  thread_id, thread_name, applied_tags
)
SELECT
  s.id, 0, s.webhook_url,
  COALESCE(NULLIF(TRIM(s.webhook_name), ''), fg.webhook_name),
  COALESCE(NULLIF(TRIM(s.webhook_avatar_url), ''), fg.webhook_avatar_url),
  s.silent, s.mention_everyone, s.mention_here, s.mention_role_ids, s.mention_user_ids,
  s.thread_id, s.thread_name, s.applied_tags
FROM sources s
LEFT JOIN source_first_group fg ON fg.source_id = s.id
WHERE TRIM(COALESCE(s.webhook_url, '')) <> '';

-- Group fallback path: only sources without their own webhook use group webhooks today.
-- Duplicate raw URL + thread candidates keep the lowest group id, matching SourceGroupRepository order.
WITH group_candidates AS (
  SELECT
    s.id AS source_id,
    g.id AS group_id,
    g.webhook_url AS webhook_url,
    COALESCE(NULLIF(TRIM(s.webhook_name), ''), g.webhook_name) AS webhook_name,
    COALESCE(NULLIF(TRIM(s.webhook_avatar_url), ''), g.webhook_avatar_url) AS webhook_avatar_url,
    s.silent AS silent,
    s.mention_everyone AS mention_everyone,
    s.mention_here AS mention_here,
    s.mention_role_ids AS mention_role_ids,
    s.mention_user_ids AS mention_user_ids,
    s.thread_id AS thread_id,
    s.thread_name AS thread_name,
    s.applied_tags AS applied_tags,
    ROW_NUMBER() OVER (
      PARTITION BY s.id, g.webhook_url, s.thread_id
      ORDER BY g.id
    ) AS dedup_rank
  FROM sources s
  JOIN source_groups sg ON sg.source_id = s.id
  JOIN "groups" g ON g.id = sg.group_id
  WHERE TRIM(COALESCE(s.webhook_url, '')) = ''
    AND TRIM(COALESCE(g.webhook_url, '')) <> ''
), deduped AS (
  SELECT * FROM group_candidates WHERE dedup_rank = 1
), positioned AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY group_id) - 1 AS destination_position
  FROM deduped
)
INSERT INTO source_destinations (
  source_id, position, webhook_url, webhook_name, webhook_avatar_url,
  silent, mention_everyone, mention_here, mention_role_ids, mention_user_ids,
  thread_id, thread_name, applied_tags
)
SELECT
  source_id, destination_position, webhook_url, webhook_name, webhook_avatar_url,
  silent, mention_everyone, mention_here, mention_role_ids, mention_user_ids,
  thread_id, thread_name, applied_tags
FROM positioned;
