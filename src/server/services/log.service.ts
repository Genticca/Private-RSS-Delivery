import type { DeliveryLogDto, FetchLogDto, LogsResponse } from '../contracts/api.js';
import type { DeliveryLogRepository, FetchLogRepository, SourceRepository } from '../db/index.js';
import { validationError } from './errors.js';
import { toDeliveryLogDto, toFetchLogDto } from './serialization.js';

export type LogType = 'delivery' | 'fetch';

export interface LogServiceOptions {
  repositories: {
    deliveryLogs: Pick<DeliveryLogRepository, 'list' | 'listAfterId'>;
    fetchLogs: Pick<FetchLogRepository, 'list' | 'listAfterId'>;
    sources: Pick<SourceRepository, 'getById'>;
  };
}

export interface SseLogEvent {
  event: LogType;
  id: number;
  data: DeliveryLogDto | FetchLogDto;
}

export class LogService {
  constructor(private readonly options: LogServiceOptions) { }

  list(type: LogType, options: {
    limit?: number;
    before?: number
  } = {}): LogsResponse {
    const limit = clampLimit(options.limit);
    if (type === 'delivery') {
      const rows = this.options.repositories.deliveryLogs.list({ limit, before: options.before });
      return { items: rows.map(toDeliveryLogDto), nextBefore: rows.length === limit ? rows.at(-1)?.id ?? null : null };
    }
    if (type === 'fetch') {
      const rows = this.options.repositories.fetchLogs.list({ limit, before: options.before });
      return { items: rows.map((row) => toFetchLogDto(row, this.sourceName(row.sourceId))), nextBefore: rows.length === limit ? rows.at(-1)?.id ?? null : null };
    }
    throw validationError('type 값이 올바르지 않습니다.', { type: 'delivery 또는 fetch만 허용됩니다.' });
  }

  backfill(limit = 50): SseLogEvent[] {
    const delivery = this.options.repositories.deliveryLogs.list({ limit }).map(toDeliveryLogDto).reverse();
    const fetch = this.options.repositories.fetchLogs.list({ limit }).map((row) => toFetchLogDto(row, this.sourceName(row.sourceId))).reverse();
    return mergeLogEvents(delivery, fetch);
  }

  after(deliveryAfterId: number, fetchAfterId: number, limit = 100): SseLogEvent[] {
    const delivery = this.options.repositories.deliveryLogs.listAfterId(deliveryAfterId, limit).map(toDeliveryLogDto);
    const fetch = this.options.repositories.fetchLogs.listAfterId(fetchAfterId, limit).map((row) => toFetchLogDto(row, this.sourceName(row.sourceId)));
    return mergeLogEvents(delivery, fetch);
  }

  /** 로그에 사람이 알아볼 소스 라벨을 붙이기 위한 조회(이름 미설정 시 null → 프런트가 ID로 폴백). */
  private sourceName(sourceId: string): string | null {
    return this.options.repositories.sources.getById(sourceId)?.name ?? null;
  }
}

function mergeLogEvents(delivery: readonly DeliveryLogDto[], fetch: readonly FetchLogDto[]): SseLogEvent[] {
  const deliveryEvents = delivery.map((data) => ({ event: 'delivery' as const, id: data.id, data }));
  const fetchEvents = fetch.map((data) => ({ event: 'fetch' as const, id: data.id, data }));
  // 초기 표시와 추가 수신에 같은 정렬을 쓴다. ID가 같으면 로그 종류로 순서를 고정한다.
  return [...deliveryEvents, ...fetchEvents].sort(
    (left, right) => left.id - right.id || left.event.localeCompare(right.event)
  );
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit)) return 100;
  return Math.max(1, Math.min(limit, 500));
}
