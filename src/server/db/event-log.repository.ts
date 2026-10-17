import type { EventKind } from '../contracts/api.js';
import type { EventStatus } from '../contracts/api.js';
import type Database from 'better-sqlite3';
import { nullable } from '../core/db.js';
import { nowIso } from '../core/db.js';
import type { FetchEventStatus } from '../contracts/api.js';
import { subtractDaysIso } from '../core/db.js';

export interface EventLogRecord {
  id: number;
  createdAt: string;
  kind: EventKind;
  status: EventStatus;
  sourceId: string | null;
  itemId: number | null;
  jobId: number | null;
  httpStatus: number | null;
  durationMs: number | null;
  itemCount: number | null;
  detail: string | null;
}

export interface AppendEventInput {
  kind: EventKind;
  status: EventStatus;
  /** 생략하면 itemId의 항목에서 소스를 찾는다. */
  sourceId?: string | null;
  itemId?: number | null;
  jobId?: number | null;
  httpStatus?: number | null;
  durationMs?: number | null;
  itemCount?: number | null;
  detail?: string | null;
  createdAt?: string;
}

const COLUMNS = `id, created_at AS createdAt, kind, status, source_id AS sourceId, item_id AS itemId, job_id AS jobId,
  http_status AS httpStatus, duration_ms AS durationMs, item_count AS itemCount, detail`;

const MAX_DETAIL_LENGTH = 1000;

/** 수집·발송·번역 결과를 한 테이블에 남긴다. 로그 화면, 소스의 마지막 수집 결과, 번역 상태가 이 기록을 읽는다. */
export class EventLogRepository {
  constructor(private readonly db: Database.Database) { }

  append(input: AppendEventInput): number {
    const itemId = nullable(input.itemId);
    const result = this.db.prepare(`INSERT INTO event_log
        (created_at, kind, status, source_id, item_id, job_id, http_status, duration_ms, item_count, detail)
      VALUES (?, ?, ?, COALESCE(?, (SELECT source_id FROM items WHERE id = ?)), ?, ?, ?, ?, ?, ?)`).run(
      input.createdAt ?? nowIso(),
      input.kind,
      input.status,
      nullable(input.sourceId),
      itemId,
      itemId,
      nullable(input.jobId),
      nullable(input.httpStatus),
      nullable(input.durationMs),
      nullable(input.itemCount),
      truncate(input.detail)
    );
    return Number(result.lastInsertRowid);
  }

  list(options: {
    kind?: EventKind;
    before?: number;
    limit?: number
  } = {}): EventLogRecord[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM event_log
      WHERE (@kind IS NULL OR kind = @kind) AND (@before IS NULL OR id < @before)
      ORDER BY id DESC LIMIT @limit`).all({
      kind: options.kind ?? null,
      before: options.before ?? null,
      limit: options.limit ?? 100
    }) as EventLogRecord[];
  }

  listAfterId(afterId: number, limit = 100): EventLogRecord[] {
    return this.db.prepare(`SELECT ${COLUMNS} FROM event_log WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(afterId, limit) as EventLogRecord[];
  }

  latestFetchStatusBySourceIds(sourceIds: readonly string[]): Map<string, FetchEventStatus> {
    // 소스별로 쿼리를 반복하지 않고, 각 소스의 가장 최근 수집 결과만 한 번에 조회한다.
    const output = new Map<string, FetchEventStatus>();
    if (sourceIds.length === 0) return output;
    const placeholders = sourceIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT source_id AS sourceId, status FROM (
        SELECT source_id, status, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY id DESC) AS rank
        FROM event_log WHERE kind = 'fetch' AND source_id IN (${placeholders})
      ) WHERE rank = 1`).all(...sourceIds) as Array<{
      sourceId: string;
      status: FetchEventStatus
    }>;
    for (const row of rows) output.set(row.sourceId, row.status);
    return output;
  }

  /** 가장 최근의 실제 번역 요청 결과다. 캐시 사용과 건너뛰기는 제외한다. */
  latestTranslationRequest(): EventLogRecord | null {
    return this.db.prepare(`SELECT ${COLUMNS} FROM event_log
      WHERE kind = 'translation' AND status IN ('success', 'failed') ORDER BY id DESC LIMIT 1`).get() as EventLogRecord ?? null;
  }

  countByStatus(kind: EventKind): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM event_log WHERE kind = ? GROUP BY status').all(kind) as Array<{
      status: string;
      count: number
    }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  pruneOlderThan(days: number, baseIso = nowIso()): number {
    return this.db.prepare('DELETE FROM event_log WHERE created_at < ?').run(subtractDaysIso(baseIso, days)).changes;
  }
}

function truncate(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > MAX_DETAIL_LENGTH ? `${value.slice(0, MAX_DETAIL_LENGTH - 1)}…` : value;
}
