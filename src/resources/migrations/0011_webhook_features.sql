-- 0011_webhook_features.sql — Discord webhook delivery options and edit tracking.

ALTER TABLE sources ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN mention_role_ids TEXT;
ALTER TABLE sources ADD COLUMN mention_user_ids TEXT;
ALTER TABLE sources ADD COLUMN mention_everyone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN thread_id TEXT;
ALTER TABLE sources ADD COLUMN thread_name TEXT;
ALTER TABLE sources ADD COLUMN applied_tags TEXT;
ALTER TABLE sources ADD COLUMN edit_in_place INTEGER NOT NULL DEFAULT 0;

ALTER TABLE delivery_log ADD COLUMN discord_message_id TEXT;

CREATE INDEX idx_delivery_log_message ON delivery_log(item_id, destination_key);
