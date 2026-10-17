import type { ItemRecord, SourceRecord } from '../../db/index.js';

export type DeliveryOperation = 'initial_post' | 'edit' | 'update_post';
export type DeliveryJobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'held' | 'unknown' | 'legacy_unknown' | 'uneditable';

export function updateOperation(source: Pick<SourceRecord, 'editInPlace'>): DeliveryOperation {
  return source.editInPlace ? 'edit' : 'update_post';
}

export function shouldHoldNewItems(newCount: number, totalCount: number, limits: { holdCount: number; holdMinItems: number; holdRatio: number }): boolean {
  return newCount >= limits.holdCount || (newCount >= limits.holdMinItems && newCount / Math.max(1, totalCount) >= limits.holdRatio);
}

export function itemOrder(item: Pick<ItemRecord, 'publishedAt' | 'updatedAt' | 'createdAt'>): string {
  return item.publishedAt ?? item.updatedAt ?? item.createdAt;
}

export function retryAt(now: string, failures: number, retryAfterMs?: number): string {
  return new Date(Date.parse(now) + Math.max(retryAfterMs ?? 0, Math.min(480_000, 60_000 * 2 ** Math.max(0, failures - 1)))).toISOString();
}
