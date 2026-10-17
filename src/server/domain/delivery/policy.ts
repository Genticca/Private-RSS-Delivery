import type { SourceRecord } from '../../db/source.repository.js';

export type DeliveryOperation = 'initial_post' | 'edit' | 'update_post';

export type DeliveryJobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'held' | 'unknown' | 'uneditable';

export function updateOperation(source: Pick<SourceRecord, 'editInPlace'>): DeliveryOperation {
  return source.editInPlace ? 'edit' : 'update_post';
}

export function shouldHoldNewItems(newCount: number, totalCount: number, limits: {
  holdCount: number;
  holdMinItems: number;
  holdRatio: number
}): boolean {
  const exceedsCountLimit = newCount >= limits.holdCount;
  const hasEnoughItems = newCount >= limits.holdMinItems;
  const newItemRatio = newCount / Math.max(1, totalCount);

  // 소수의 업데이트만으로 비율이 높아져 보류되지 않도록 최소 건수도 확인한다.
  return exceedsCountLimit || (hasEnoughItems && newItemRatio >= limits.holdRatio);
}

export function retryAt(now: string, failures: number, retryAfterMs?: number): string {
  const failureExponent = Math.max(0, failures - 1);
  const backoffMs = Math.min(480_000, 60_000 * 2 ** failureExponent);
  // 자체 재시도 간격보다 서버의 Retry-After가 길면 서버가 지정한 시간을 따른다.
  const delayMs = Math.max(retryAfterMs ?? 0, backoffMs);
  return new Date(Date.parse(now) + delayMs).toISOString();
}
