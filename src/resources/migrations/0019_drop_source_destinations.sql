-- 0019_drop_source_destinations.sql - Remove D23 per-source delivery destinations.
DROP INDEX IF EXISTS idx_source_destinations_source_position;
DROP INDEX IF EXISTS idx_source_destinations_unique_raw;
DROP INDEX IF EXISTS idx_source_destinations_unique_canonical_thread;
DROP TABLE IF EXISTS source_destinations;
