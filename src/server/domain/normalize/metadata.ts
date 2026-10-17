import type { FeedEnvelope, NormalizedItem } from './types.js';

const METADATA_FIELDS = ['publishedAt', 'updatedAt', 'author', 'commentsUrl', 'image'] as const;

/** 본문 정규화와 별개로, 값이 있는 공통 메타데이터만 결과에 옮긴다. */
export function copyFeedMetadata(item: NormalizedItem, envelope: FeedEnvelope): void {
  for (const field of METADATA_FIELDS) {
    const value = envelope[field];
    if (value !== undefined && value !== '') {
      item[field] = value;
    }
  }
}
