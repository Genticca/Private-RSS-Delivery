import type { NormalizedItem } from '../domain/normalize/types.js';
import type { SourceRecord } from '../db/source.repository.js';

export function shouldQueueNewItem(source: SourceRecord, item: NormalizedItem): boolean {
  if (!source.initialized) return false;
  if (!item.publishedAt) return true;
  if (!source.deliveryCutoffAt) return true;
  return item.publishedAt >= source.deliveryCutoffAt;
}
