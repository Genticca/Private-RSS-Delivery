import type { EventKind, EventStatus, EventLogRepository, EventLogRecord } from './repository.js';

export interface EventLogDto {
  id: number;
  createdAt: string;
  kind: EventKind;
  status: EventStatus;
  sourceId: string | null;
  sourceName: string | null;
  itemId: number | null;
  jobId: number | null;
  httpStatus: number | null;
  durationMs: number | null;
  itemCount: number | null;
  detail: string | null;
}

export interface PaginatedResponse<T> {
  items: T[];
  nextBefore: number | null;
}

export type LogsResponse = PaginatedResponse<EventLogDto>;

export type LogType = EventKind;

export interface LogServiceOptions {
  repositories: {
    eventLog: Pick<EventLogRepository, 'list' | 'listAfterId'>;
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
    return rows.map((row) => toEventLogDto(row, row.sourceName ?? null));
  }
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit)) return 100;
  return Math.max(1, Math.min(limit, 500));
}

export function toEventLogDto(record: EventLogRecord, sourceName: string | null): EventLogDto {
  return { ...record, sourceName };
}
