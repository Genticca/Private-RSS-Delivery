-- 0017_source_destinations_canonical_unique.sql - Enforce canonical webhook/thread uniqueness.

-- Keep the first visible destination when canonical URL + thread collide.
DELETE FROM source_destinations
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY
          source_id,
          lower(rtrim(
            CASE
              WHEN instr(webhook_url, '?') > 0 AND (instr(webhook_url, '#') = 0 OR instr(webhook_url, '?') < instr(webhook_url, '#')) THEN substr(webhook_url, 1, instr(webhook_url, '?') - 1)
              WHEN instr(webhook_url, '#') > 0 THEN substr(webhook_url, 1, instr(webhook_url, '#') - 1)
              ELSE webhook_url
            END,
            '/'
          )),
          COALESCE(thread_id, '')
        ORDER BY position, id
      ) AS duplicate_rank
    FROM source_destinations
  )
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_source_destinations_unique_canonical_thread
  ON source_destinations(
    source_id,
    lower(rtrim(
      CASE
        WHEN instr(webhook_url, '?') > 0 AND (instr(webhook_url, '#') = 0 OR instr(webhook_url, '?') < instr(webhook_url, '#')) THEN substr(webhook_url, 1, instr(webhook_url, '?') - 1)
        WHEN instr(webhook_url, '#') > 0 THEN substr(webhook_url, 1, instr(webhook_url, '#') - 1)
        ELSE webhook_url
      END,
      '/'
    )),
    COALESCE(thread_id, '')
  );
