-- 0016_sources_feed_url_unique.sql - Enforce one normalized feed URL per source.

-- Keep the row that existing SourceRepository.findByFeedUrl() would have returned.
DELETE FROM sources
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (PARTITION BY feed_url ORDER BY created_at DESC, id) AS duplicate_rank
    FROM sources
  )
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_feed_url_unique
  ON sources(feed_url);
