import type Database from 'better-sqlite3';

export interface TranslationCacheRecord {
  cacheKey: string;
  field: 'title' | 'summary';
  status: 'success' | 'failed';
  value: string | null;
  lastError: string | null;
  retryAfter: string | null;
}

/** 필드별 번역 성공값과 실패 대기 시각을 저장한다. 사용 기록은 event_log에 남긴다. */
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
}
