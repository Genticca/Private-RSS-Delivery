import type Database from 'better-sqlite3';
import type { DeliveryLogRepository, FetchLogRepository, ModelUsageRepository } from '../db/index.js';
import { subtractDaysIso } from '../db/time.js';

export interface CleanupRunResult { deliveryLogs: number; fetchLogs: number; modelUsage: number; }
export interface CleanupRepositories {
  deliveryLogs: Pick<DeliveryLogRepository, 'pruneOlderThan'>;
  fetchLogs: Pick<FetchLogRepository, 'pruneOlderThan'>;
  modelUsage: Pick<ModelUsageRepository, 'pruneOlderThan'>;
}

export class CleanupService {
  constructor(private readonly db: Database.Database, private readonly repositories: CleanupRepositories) {}

  run(now: string, retentionDays: number, itemRetentionDays?: number): CleanupRunResult {
    return this.db.transaction(() => {
      const result = {
        deliveryLogs: this.repositories.deliveryLogs.pruneOlderThan(retentionDays, now),
        fetchLogs: this.repositories.fetchLogs.pruneOlderThan(retentionDays, now),
        modelUsage: this.repositories.modelUsage.pruneOlderThan(retentionDays, now)
      };
      if (itemRetentionDays !== undefined) {
        this.db.prepare('DELETE FROM translation_events WHERE created_at < ?').run(subtractDaysIso(now, retentionDays));
        this.db.prepare("DELETE FROM translation_cache WHERE status = 'failed' AND updated_at < ?").run(subtractDaysIso(now, retentionDays));
        this.db.prepare(`UPDATE items SET summary = NULL, translated_title = NULL, translated_summary = NULL,
          translated_at = NULL, image = NULL, content_pruned = 1 WHERE content_pruned = 0 AND last_seen_at < ?
          AND NOT EXISTS(SELECT 1 FROM delivery_jobs j WHERE j.item_id = items.id
            AND j.state IN ('pending','running','held','unknown','legacy_unknown','failed','uneditable'))`)
          .run(subtractDaysIso(now, itemRetentionDays));
        this.db.prepare(`UPDATE delivery_jobs SET item_snapshot = '{}', source_snapshot = '{}', payload = NULL, template_body = ''
          WHERE state IN ('succeeded','cancelled') AND completed_at < ?`).run(subtractDaysIso(now, retentionDays));
        this.db.prepare('DELETE FROM destination_cooldowns WHERE until_at < ?').run(now);
      }
      return result;
    })();
  }
}
