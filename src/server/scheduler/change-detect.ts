import type { ItemRecord } from '../db/item.repository.js';
import type { NormalizedItem } from '../domain/normalize/types.js';

export type ExistingItemDecision = 'skipped' | 'changed-requeue' | 'changed-retain';

export function classifyExistingItem(existing: ItemRecord, next: NormalizedItem): ExistingItemDecision {
  if (existing.contentHash === next.contentHash) return 'skipped';
  return existing.deliveryStatus === 'delivered' ? 'changed-requeue' : 'changed-retain';
}
