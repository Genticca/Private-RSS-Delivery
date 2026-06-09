-- 0008_delivery_state.sql — Item delivery lifecycle, render fields, and per-destination log keys.

ALTER TABLE items ADD COLUMN link TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN author TEXT;
ALTER TABLE items ADD COLUMN comments_url TEXT;
ALTER TABLE items ADD COLUMN image TEXT;
ALTER TABLE items ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'historical'));
ALTER TABLE items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE items ADD COLUMN failed_at TEXT;
ALTER TABLE items ADD COLUMN failure_reason TEXT;
ALTER TABLE items ADD COLUMN translated_title TEXT;
ALTER TABLE items ADD COLUMN translated_summary TEXT;
ALTER TABLE items ADD COLUMN translated_at TEXT;

UPDATE items
SET delivery_status = CASE
  WHEN delivered_at IS NOT NULL THEN 'delivered'
  ELSE 'historical'
END;

ALTER TABLE delivery_log ADD COLUMN destination_key TEXT;
ALTER TABLE delivery_log ADD COLUMN content_hash TEXT;
ALTER TABLE delivery_log ADD COLUMN failure_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_items_pending_next_attempt
  ON items(next_attempt_at)
  WHERE delivery_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_delivery_log_resolution
  ON delivery_log(item_id, destination_key, content_hash, status, failure_reason);
