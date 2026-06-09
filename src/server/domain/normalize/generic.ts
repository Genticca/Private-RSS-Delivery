import { computeGenericContentHash } from './content-hash.js';
import { cleanSummary, cleanTitle } from './html.js';
import type { FeedEnvelope, NormalizedItem } from './types.js';

export function normalizeGeneric(env: FeedEnvelope): NormalizedItem {
  const title = cleanTitle(env.title);
  const summary = cleanSummary(env.rawBody);
  const item: NormalizedItem = {
    atomId: env.atomId,
    title,
    link: env.link,
    summary,
    contentHash: computeGenericContentHash({ title, link: env.link })
  };

  assignOptional(item, 'publishedAt', env.publishedAt);
  assignOptional(item, 'updatedAt', env.updatedAt);
  assignOptional(item, 'author', env.author);
  assignOptional(item, 'commentsUrl', env.commentsUrl);
  assignOptional(item, 'image', env.image);
  return item;
}

function assignOptional<K extends keyof NormalizedItem>(
  item: NormalizedItem,
  key: K,
  value: NormalizedItem[K] | undefined
): void {
  if (value !== undefined && value !== '') {
    item[key] = value;
  }
}
