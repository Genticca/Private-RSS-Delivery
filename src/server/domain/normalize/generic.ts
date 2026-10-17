import { computeGenericContentHash } from './content-hash.js';
import { cleanSummary, cleanTitle } from './html.js';
import { copyFeedMetadata } from './metadata.js';
import type { FeedEnvelope, NormalizedItem } from './types.js';

/** 일반 피드는 본문을 표시용으로 정제하고, 제목·링크를 기준으로 변경을 감지한다. */
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

  copyFeedMetadata(item, env);
  return item;
}
