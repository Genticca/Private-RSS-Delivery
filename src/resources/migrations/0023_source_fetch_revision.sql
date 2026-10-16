-- Replace the trigger through a new version; prior migrations remain immutable.
DROP TRIGGER sources_config_revision;
CREATE TRIGGER sources_config_revision AFTER UPDATE OF feed_url, profile, enabled, thread_id, thread_name,
  applied_tags, template_id, translate, silent, mention_role_ids, mention_user_ids, mention_everyone,
  mention_here, webhook_name, webhook_avatar_url, edit_in_place, fetch_options, poll_interval_seconds ON sources
BEGIN
  UPDATE sources SET config_revision = config_revision + 1 WHERE id = NEW.id;
END;
