import { XMLParser, XMLValidator } from 'fast-xml-parser';

type XmlNode = Record<string, unknown>;

const TEXT_NODE = '#text';

const ATTR_PREFIX = '@_';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  textNodeName: TEXT_NODE,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true
});

export function parseFeed(rawXml: string): FeedEnvelope[] {
  // 이 단계는 RSS·Atom의 구조 차이만 흡수한다. HTML 정제는 normalize에서 수행한다.
  const validation = XMLValidator.validate(rawXml);
  if (validation !== true) {
    throw new Error('Invalid feed XML.');
  }

  const parsed = parser.parse(rawXml) as unknown;
  if (!isXmlNode(parsed)) {
    throw new Error('Feed XML did not parse to an object.');
  }

  if (isXmlNode(parsed.rss)) {
    return dedupeFirstWins(mapRssFeed(parsed.rss));
  }
  if (isXmlNode(parsed.feed)) {
    return dedupeFirstWins(mapAtomFeed(parsed.feed));
  }

  throw new Error('Unsupported feed root. Expected <rss> or <feed>.');
}

function mapRssFeed(rss: XmlNode): FeedEnvelope[] {
  const channel = firstNode(rss.channel);
  if (!channel) return [];

  return asArray(channel.item).flatMap((entry) => {
    if (!isXmlNode(entry)) return [];
    const link = text(entry.link) ?? '';
    const atomId = text(entry.guid) ?? nonEmpty(link);
    if (!atomId) return [];

    const pubDate = isoDate(text(entry.pubDate));
    const rawBody = text(entry['content:encoded']) ?? text(entry.content) ?? text(entry.description) ?? '';
    const env: FeedEnvelope = {
      atomId,
      title: text(entry.title) ?? '',
      link,
      rawBody,
      categories: categoriesFromRss(entry)
    };

    assignOptional(env, 'publishedAt', pubDate);
    assignOptional(env, 'updatedAt', pubDate);
    assignOptional(env, 'author', text(entry['dc:creator']) ?? text(entry.author));
    assignOptional(env, 'commentsUrl', text(entry.comments) ?? urlText(entry['wfw:comment']) ?? urlText(entry['slash:comments']));
    assignOptional(env, 'image', imageFromRss(entry));
    return [env];
  });
}

function mapAtomFeed(feed: XmlNode): FeedEnvelope[] {
  const feedAuthor = authorName(feed.author);

  return asArray(feed.entry).flatMap((entry) => {
    if (!isXmlNode(entry)) return [];
    const atomId = text(entry.id);
    if (!atomId) return [];

    const updatedAt = isoDate(text(entry.updated));
    const publishedAt = isoDate(text(entry.published)) ?? updatedAt;
    const env: FeedEnvelope = {
      atomId,
      title: text(entry.title) ?? '',
      link: atomLink(entry.link, 'alternate') ?? atomLink(entry.link) ?? '',
      rawBody: text(entry['content:encoded']) ?? text(entry.content) ?? text(entry.summary) ?? text(entry.description) ?? '',
      categories: categoriesFromAtom(entry)
    };

    assignOptional(env, 'publishedAt', publishedAt);
    assignOptional(env, 'updatedAt', updatedAt);
    assignOptional(env, 'author', authorName(entry.author) ?? feedAuthor);
    assignOptional(env, 'commentsUrl', atomLink(entry.link, 'replies'));
    assignOptional(env, 'image', imageFromAtom(entry));
    return [env];
  });
}

function dedupeFirstWins(items: FeedEnvelope[]): FeedEnvelope[] {
  // 같은 ID가 반복되면 문서에 먼저 나온 항목을 유지한다.
  const seen = new Set<string>();
  const result: FeedEnvelope[] = [];
  for (const item of items) {
    if (seen.has(item.atomId)) continue;
    seen.add(item.atomId);
    result.push(item);
  }
  return result;
}

function categoriesFromRss(entry: XmlNode): string[] {
  return uniqueStrings([...textList(entry.category), ...textList(entry['dc:subject'])]);
}

function categoriesFromAtom(entry: XmlNode): string[] {
  return uniqueStrings(
    asArray(entry.category)
      .map((category) => attr(category, 'term') ?? text(category))
      .filter(isNonEmptyString)
  );
}

function imageFromRss(entry: XmlNode): string | undefined {
  return (
    mediaUrl(entry['media:thumbnail']) ??
    mediaUrl(entry['media:content']) ??
    imageEnclosureUrl(entry.enclosure) ??
    attr(firstNode(entry['itunes:image']), 'href')
  );
}

function imageFromAtom(entry: XmlNode): string | undefined {
  return mediaUrl(entry['media:thumbnail']) ?? mediaUrl(entry['media:content']) ?? imageEnclosureUrl(entry.link);
}

function imageEnclosureUrl(value: unknown): string | undefined {
  return asArray(value)
    .map((candidate) => {
      const type = attr(candidate, 'type')?.toLowerCase();
      const rel = attr(candidate, 'rel')?.toLowerCase();
      if (type?.startsWith('image/') || rel === 'enclosure') return attr(candidate, 'url') ?? attr(candidate, 'href');
      return undefined;
    })
    .find(isNonEmptyString);
}

function mediaUrl(value: unknown): string | undefined {
  return asArray(value)
    .map((candidate) => attr(candidate, 'url'))
    .find(isNonEmptyString);
}

function atomLink(value: unknown, rel?: string): string | undefined {
  const links = asArray(value);
  const normalizedRel = rel?.toLowerCase();
  const match = links.find((candidate) => {
    if (!isXmlNode(candidate)) return false;
    const candidateRel = attr(candidate, 'rel')?.toLowerCase();
    return normalizedRel ? candidateRel === normalizedRel : candidateRel === undefined || candidateRel === 'alternate';
  });
  return attr(match, 'href') ?? text(match);
}

function authorName(value: unknown): string | undefined {
  const author = firstNode(value);
  if (!author) return text(value) ?? undefined;
  return text(author.name) ?? text(author);
}

function textList(value: unknown): string[] {
  return asArray(value).map(text).filter(isNonEmptyString);
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return nonEmpty(String(value));
  }
  if (isXmlNode(value)) {
    return text(value[TEXT_NODE]);
  }
  return undefined;
}

function urlText(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  return /^https?:\/\//i.test(candidate) ? candidate : undefined;
}

function attr(value: unknown, name: string): string | undefined {
  if (!isXmlNode(value)) return undefined;
  const candidate = value[`${ATTR_PREFIX}${name}`];
  return typeof candidate === 'string' ? nonEmpty(candidate) : undefined;
}

function firstNode(value: unknown): XmlNode | undefined {
  const first = asArray(value).find(isXmlNode);
  return first;
}

function asArray(value: unknown): unknown[] {
  // XML 파서가 단일 노드와 반복 노드를 서로 다른 모양으로 반환하는 차이를 숨긴다.
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

function assignOptional<K extends keyof FeedEnvelope>(
  env: FeedEnvelope,
  key: K,
  value: FeedEnvelope[K] | undefined
): void {
  if (value !== undefined && value !== '') {
    env[key] = value;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(isNonEmptyString))];
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isXmlNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const PROFILES = ['generic', 'incident-io', 'atlassian-statuspage'] as const;

export type Profile = (typeof PROFILES)[number];

export const SOURCE_PROFILE_OPTIONS = ['auto', ...PROFILES] as const;

export type SourceProfile = (typeof SOURCE_PROFILE_OPTIONS)[number];

export const INCIDENT_STAGES = ['Investigating', 'Identified', 'Monitoring', 'Resolved', 'Update'] as const;

export type KnownIncidentStage = (typeof INCIDENT_STAGES)[number];

export type IncidentStage = KnownIncidentStage | (string & {});

export interface FeedEnvelope {
  /** 피드 원본에서 추출한 식별자. 내용이 바뀌어도 동일 항목을 찾는 기준이다. */
  atomId: string;
  title: string;
  link: string;
  publishedAt?: string;
  updatedAt?: string;
  author?: string;
  commentsUrl?: string;
  image?: string;
  rawBody: string;
  categories: string[];
}

export interface NormalizedItem {
  atomId: string;
  title: string;
  link: string;
  publishedAt?: string;
  updatedAt?: string;
  author?: string;
  commentsUrl?: string;
  image?: string;
  summary: string;
  incidentStage?: IncidentStage;
  /** 프로필별 변경 감지 기준으로 계산하며 항목 ID와는 별도로 사용한다. */
  contentHash: string;
}
