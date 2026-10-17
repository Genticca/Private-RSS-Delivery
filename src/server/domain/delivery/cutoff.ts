import type { SourceRecord } from '../../sources/repository.js';
import type { NormalizedItem } from '../../feed/parse.js';

export function shouldQueueNewItem(source: SourceRecord, item: NormalizedItem): boolean {
  // 첫 수집은 과거 항목의 기준점만 만든다. 기존 공지가 한꺼번에 발송되는 것을 막는다.
  if (!source.initialized) return false;
  // 발행 시각이 없으면 과거 항목인지 판별할 수 없으므로 초기화 이후에는 발송한다.
  if (!item.publishedAt) return true;
  if (!source.deliveryCutoffAt) return true;
  return item.publishedAt >= source.deliveryCutoffAt;
}
