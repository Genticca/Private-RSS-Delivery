-- 0018_runtime_timestamp_iso_z_backfill.sql - Backfill runtime timestamps to ISO-Z text.

UPDATE sources
SET
  created_at = CASE WHEN instr(created_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at) ELSE created_at END,
  delivery_cutoff_at = CASE WHEN delivery_cutoff_at IS NOT NULL AND instr(delivery_cutoff_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', delivery_cutoff_at), delivery_cutoff_at) ELSE delivery_cutoff_at END,
  last_polled_at = CASE WHEN last_polled_at IS NOT NULL AND instr(last_polled_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', last_polled_at), last_polled_at) ELSE last_polled_at END,
  next_poll_at = CASE WHEN next_poll_at IS NOT NULL AND instr(next_poll_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', next_poll_at), next_poll_at) ELSE next_poll_at END
WHERE instr(created_at, 'T') = 0
   OR (delivery_cutoff_at IS NOT NULL AND instr(delivery_cutoff_at, 'T') = 0)
   OR (last_polled_at IS NOT NULL AND instr(last_polled_at, 'T') = 0)
   OR (next_poll_at IS NOT NULL AND instr(next_poll_at, 'T') = 0);

UPDATE items
SET
  created_at = CASE WHEN instr(created_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at) ELSE created_at END,
  delivered_at = CASE WHEN delivered_at IS NOT NULL AND instr(delivered_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at), delivered_at) ELSE delivered_at END,
  next_attempt_at = CASE WHEN next_attempt_at IS NOT NULL AND instr(next_attempt_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at), next_attempt_at) ELSE next_attempt_at END,
  published_at = CASE WHEN published_at IS NOT NULL AND instr(published_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', published_at), published_at) ELSE published_at END,
  updated_at = CASE WHEN updated_at IS NOT NULL AND instr(updated_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), updated_at) ELSE updated_at END,
  failed_at = CASE WHEN failed_at IS NOT NULL AND instr(failed_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', failed_at), failed_at) ELSE failed_at END,
  translated_at = CASE WHEN translated_at IS NOT NULL AND instr(translated_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', translated_at), translated_at) ELSE translated_at END
WHERE instr(created_at, 'T') = 0
   OR (delivered_at IS NOT NULL AND instr(delivered_at, 'T') = 0)
   OR (next_attempt_at IS NOT NULL AND instr(next_attempt_at, 'T') = 0)
   OR (published_at IS NOT NULL AND instr(published_at, 'T') = 0)
   OR (updated_at IS NOT NULL AND instr(updated_at, 'T') = 0)
   OR (failed_at IS NOT NULL AND instr(failed_at, 'T') = 0)
   OR (translated_at IS NOT NULL AND instr(translated_at, 'T') = 0);

UPDATE templates
SET
  created_at = CASE WHEN instr(created_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at) ELSE created_at END,
  updated_at = CASE WHEN instr(updated_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), updated_at) ELSE updated_at END
WHERE instr(created_at, 'T') = 0 OR instr(updated_at, 'T') = 0;

UPDATE "groups"
SET
  created_at = CASE WHEN instr(created_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at) ELSE created_at END,
  updated_at = CASE WHEN instr(updated_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at), updated_at) ELSE updated_at END
WHERE instr(created_at, 'T') = 0 OR instr(updated_at, 'T') = 0;

UPDATE delivery_log
SET created_at = CASE WHEN instr(created_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at) ELSE created_at END
WHERE instr(created_at, 'T') = 0;

UPDATE fetch_log
SET created_at = CASE WHEN instr(created_at, 'T') = 0 THEN COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', created_at), created_at) ELSE created_at END
WHERE instr(created_at, 'T') = 0;
