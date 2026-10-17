import type { EventLogRepository } from '../db/event-log.repository.js';
import type Database from 'better-sqlite3';
import { subtractDaysIso } from '../core/db.js';

export interface CleanupRunResult {
  events: number;
}

export interface CleanupRepositories {
  eventLog: Pick<EventLogRepository, 'pruneOlderThan'>;
}

// 실패 캐시와 완료 작업의 내용은 로그 보존 기간과 별개로 90일간 보존한다.
const CACHE_AND_SNAPSHOT_RETENTION_DAYS = 90;

export class CleanupService {
  constructor(private readonly db: Database.Database, private readonly repositories: CleanupRepositories) { }

  run(now: string, logRetentionDays: number, itemRetentionDays?: number): CleanupRunResult {
    return this.db.transaction(() => {
      const result = { events: this.repositories.eventLog.pruneOlderThan(logRetentionDays, now) };
      if (itemRetentionDays !== undefined) {
        // 항목 식별자와 발송 이력은 유지하고 오래된 본문만 비운다.
        // 미해결 발송 작업이 참조하는 항목은 이후 처리에 필요하므로 보존한다.
        this.db.prepare("DELETE FROM translation_cache WHERE status = 'failed' AND updated_at < ?").run(subtractDaysIso(now, CACHE_AND_SNAPSHOT_RETENTION_DAYS));
        this.db.prepare(`UPDATE items SET summary = NULL, image = NULL, content_pruned = 1
          WHERE content_pruned = 0 AND last_seen_at < ?
          AND NOT EXISTS(SELECT 1 FROM delivery_jobs j WHERE j.item_id = items.id
            AND j.state IN ('pending','running','held','unknown','failed','uneditable'))`)
          .run(subtractDaysIso(now, itemRetentionDays));
        this.db.prepare(`UPDATE delivery_jobs SET item_snapshot = '{}', source_snapshot = '{}', payload = NULL, template_body = ''
          WHERE state IN ('succeeded','cancelled') AND completed_at < ?`).run(subtractDaysIso(now, CACHE_AND_SNAPSHOT_RETENTION_DAYS));
        this.db.prepare('DELETE FROM destination_cooldowns WHERE until_at < ?').run(now);
      }
      return result;
    })();
  }
}
