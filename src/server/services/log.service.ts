import type { DeliveryLogDto, FetchLogDto, LogsResponse } from '../contracts/api.js';
import type { RepositoryRegistry } from '../runtime/container.js';
import { validationError } from './errors.js';
import { toDeliveryLogDto, toFetchLogDto } from './serialization.js';

export type LogType = 'delivery' | 'fetch';

export interface LogServiceOptions {
  repositories: RepositoryRegistry;
}

export interface SseLogEvent {
  event: LogType;
  id: number;
  data: DeliveryLogDto | FetchLogDto;
}

export class LogService {
  constructor(private readonly options: LogServiceOptions) {}

  list(type: LogType, options: { limit?: number; before?: number } = {}): LogsResponse {
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
    return [...delivery.map((data) => ({ event: 'delivery' as const, id: data.id, data })), ...fetch.map((data) => ({ event: 'fetch' as const, id: data.id, data }))].sort(
      (left, right) => left.data.createdAt.localeCompare(right.data.createdAt) || left.id - right.id
    );
  }

  after(deliveryAfterId: number, fetchAfterId: number, limit = 100): SseLogEvent[] {
    const delivery = this.options.repositories.deliveryLogs.listAfterId(deliveryAfterId, limit).map(toDeliveryLogDto);
    const fetch = this.options.repositories.fetchLogs.listAfterId(fetchAfterId, limit).map((row) => toFetchLogDto(row, this.sourceName(row.sourceId)));
    return [...delivery.map((data) => ({ event: 'delivery' as const, id: data.id, data })), ...fetch.map((data) => ({ event: 'fetch' as const, id: data.id, data }))].sort(
      (left, right) => left.data.createdAt.localeCompare(right.data.createdAt) || left.id - right.id
    );
  }

  /** 로그에 사람이 알아볼 소스 라벨을 붙이기 위한 조회(이름 미설정 시 null → 프런트가 ID로 폴백). */
  private sourceName(sourceId: string): string | null {
    return this.options.repositories.sources.getById(sourceId)?.name ?? null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit)) return 100;
  return Math.max(1, Math.min(limit, 500));
}
