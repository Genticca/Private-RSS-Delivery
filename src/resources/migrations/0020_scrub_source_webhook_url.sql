-- 0020_scrub_source_webhook_url.sql - Remove legacy per-source webhook secrets after D24 channel unification.
UPDATE sources SET webhook_url = NULL;
