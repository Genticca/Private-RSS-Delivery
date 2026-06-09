-- 0010_iso_timestamp_backfill.sql — Backfill legacy SQLite datetime rows to ISO-Z text.

UPDATE model_config
SET
  created_at = CASE
    WHEN instr(created_at, 'T') > 0 THEN created_at
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  END,
  updated_at = CASE
    WHEN instr(updated_at, 'T') > 0 THEN updated_at
    ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
  END
WHERE instr(created_at, 'T') = 0 OR instr(updated_at, 'T') = 0;

UPDATE model_usage
SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
WHERE instr(created_at, 'T') = 0;

UPDATE schema_migrations
SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', applied_at)
WHERE instr(applied_at, 'T') = 0;
