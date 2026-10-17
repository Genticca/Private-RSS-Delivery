import type Database from 'better-sqlite3';

export interface TranslationCacheRecord {
  cacheKey: string;
  field: 'title' | 'summary';
  status: 'success' | 'failed';
  value: string | null;
  lastError: string | null;
  retryAfter: string | null;
}

/** 필드별 번역 성공값·실패 대기 시각과 캐시 사용 통계를 저장한다. */
export class TranslationCacheRepository {
  constructor(private readonly db: Database.Database) { }

  get(cacheKey: string): TranslationCacheRecord | null {
    return this.db.prepare('SELECT cache_key AS cacheKey, field, status, value, last_error AS lastError, retry_after AS retryAfter FROM translation_cache WHERE cache_key = ?').get(cacheKey) as TranslationCacheRecord ?? null;
  }

  save(row: TranslationCacheRecord, now: string): void {
    this.db.prepare(`INSERT INTO translation_cache(cache_key, field, status, value, last_error, retry_after, updated_at)
      VALUES (@cacheKey, @field, @status, @value, @lastError, @retryAfter, @now)
      ON CONFLICT(cache_key) DO UPDATE SET status = excluded.status, value = excluded.value,
        last_error = excluded.last_error, retry_after = excluded.retry_after, updated_at = excluded.updated_at`).run({ ...row, now });
  }

  event(kind: string, now: string, itemId?: number, jobId?: number): void {
    this.db.prepare('INSERT INTO translation_events(kind, created_at, item_id, job_id) VALUES (?, ?, ?, ?)').run(kind, now, itemId ?? null, jobId ?? null);
  }

  statistics(): Record<string, number> {
    const eventCounts = this.db.prepare('SELECT kind, COUNT(*) AS count FROM translation_events GROUP BY kind').all() as Array<{
      kind: string;
      count: number;
    }>;
    return Object.fromEntries(eventCounts.map((row) => [row.kind, row.count]));
  }
}
