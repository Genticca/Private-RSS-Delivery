import type { EventKind } from '../contracts/api.js';
import type { EventLogRepository } from '../db/event-log.repository.js';
import type { SourceRepository } from '../db/source.repository.js';
import type { EventLogDto } from '../contracts/api.js';
import type { LogsResponse } from '../contracts/api.js';
import type { EventLogRecord } from '../db/event-log.repository.js';
import { toEventLogDto } from './serialization.js';

export type LogType = EventKind;

export interface LogServiceOptions {
  repositories: {
    eventLog: Pick<EventLogRepository, 'list' | 'listAfterId'>;
    sources: Pick<SourceRepository, 'getById'>;
  };
}

export interface SseLogEvent {
  event: LogType;
  id: number;
  data: EventLogDto;
}

export class LogService {
  constructor(private readonly options: LogServiceOptions) { }

  list(type: LogType, options: {
    limit?: number;
    before?: number
  } = {}): LogsResponse {
    const limit = clampLimit(options.limit);
    const rows = this.options.repositories.eventLog.list({ kind: type, limit, before: options.before });
    return { items: this.toDtos(rows), nextBefore: rows.length === limit ? rows.at(-1)?.id ?? null : null };
  }

  backfill(limit = 50): SseLogEvent[] {
    return this.toEvents(this.options.repositories.eventLog.list({ limit }).reverse());
  }

  after(afterId: number, limit = 100): SseLogEvent[] {
    return this.toEvents(this.options.repositories.eventLog.listAfterId(afterId, limit));
  }

  private toEvents(rows: readonly EventLogRecord[]): SseLogEvent[] {
    return this.toDtos(rows).map((data) => ({ event: data.kind, id: data.id, data }));
  }

  /** 로그에 사람이 알아볼 소스 이름을 붙인다(이름 미설정 시 null → 화면이 ID로 표시). */
  private toDtos(rows: readonly EventLogRecord[]): EventLogDto[] {
    const names = new Map<string, string | null>();
    return rows.map((row) => {
      if (row.sourceId !== null && !names.has(row.sourceId)) {
        names.set(row.sourceId, this.options.repositories.sources.getById(row.sourceId)?.name ?? null);
      }
      return toEventLogDto(row, row.sourceId === null ? null : names.get(row.sourceId) ?? null);
    });
  }
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit)) return 100;
  return Math.max(1, Math.min(limit, 500));
}
