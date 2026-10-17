import { createHash } from 'node:crypto';
import type { FeedEnvelope } from './parse.js';
import type { NormalizedItem } from './parse.js';
import type { Profile } from './parse.js';
import type { IncidentStage } from './parse.js';
import { INCIDENT_STAGES } from './parse.js';
import type { SourceProfile } from './parse.js';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function computeGenericContentHash(input: {
  title: string;
  link: string
}): string {
  // 일반 뉴스는 제목과 링크를 기준으로 한다. 요약만 바뀌면 재발송하지 않는다.
  return sha256Hex(`${input.title}\n${input.link}`);
}

export function computeIncidentContentHash(input: {
  stage: string;
  summary: string
}): string {
  // 장애 공지는 같은 링크에서 상태가 갱신되므로 단계와 최신 본문을 비교한다.
  return sha256Hex(`${input.stage}\n${input.summary}`);
}

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

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  hellip: '...',
  copy: '(c)',
  reg: '(r)'
};

export const DEFAULT_SUMMARY_MAX_CHARS = 4000;

export function cleanTitle(value: string): string {
  return htmlToText(value, { singleLine: true, maxChars: undefined });
}

export function cleanSummary(value: string): string {
  return htmlToText(value, { singleLine: false, maxChars: DEFAULT_SUMMARY_MAX_CHARS });
}

/** HTML 구조를 줄바꿈으로 남긴 뒤 엔티티·공백·길이를 순서대로 정리해 표시용 텍스트를 만든다. */
export function htmlToText(
  value: string,
  options: {
    singleLine: boolean;
    maxChars?: number
  } = { singleLine: false }
): string {
  const withoutScripts = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

  // 태그를 지우기 전에 문단·목록 경계를 보존해야 인접한 문장이 붙지 않는다.
  const withStructuralBreaks = withoutScripts
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n· ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|blockquote|pre|tr|table|thead|tbody|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const decoded = decodeHtmlEntities(withStructuralBreaks).replace(/\u00a0/g, ' ');
  const normalized = options.singleLine ? normalizeSingleLine(decoded) : normalizeMultiline(decoded);
  return options.maxChars === undefined ? normalized : truncateAtWordBoundary(normalized, options.maxChars);
}

export function decodeHtmlEntities(value: string): string {
  // 해석할 수 없는 엔티티는 원문으로 남겨 임의로 정보를 버리지 않는다.
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

export function normalizeSingleLine(value: string): string {
  return tightenPunctuation(value.replace(/\s+/g, ' ').trim());
}

export function normalizeMultiline(value: string): string {
  const lines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => tightenPunctuation(line.replace(/[ \t\f\v]+/g, ' ').trim()))
    .filter((line) => line.length > 0);
  return lines.join('\n').trim();
}

export function truncateAtWordBoundary(value: string, maxChars: number): string {
  // 마지막 단어 경계가 너무 앞에 있으면 글자 수 기준으로 잘라 표시 공간을 확보한다.
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return '…'.slice(0, maxChars);

  const sliceMax = maxChars - 1;
  const candidate = value.slice(0, sliceMax);
  const lastWhitespace = candidate.search(/\s+\S*$/);
  const cutAt = lastWhitespace > Math.floor(sliceMax * 0.6) ? lastWhitespace : sliceMax;
  return `${candidate.slice(0, cutAt).trimEnd()}…`;
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}

function tightenPunctuation(value: string): string {
  return value.replace(/\s+([,.;:!?])/g, '$1');
}

type IncidentProfile = Extract<Profile, 'incident-io' | 'atlassian-statuspage'>;

interface IncidentUpdate {
  stage: IncidentStage;
  summary: string;
}

const INCIDENT_IO_STATUS_RE = /<(?:b|strong)\b[^>]*>\s*Status:\s*([^<]+?)\s*<\/(?:b|strong)>/i;

const PARAGRAPH_RE = /<p\b[^>]*>[\s\S]*?<\/p>/i;

const STRONG_STAGE_RE = /<strong\b[^>]*>\s*([^<]+?)\s*<\/strong>/i;

export function normalizeIncident(profile: IncidentProfile, env: FeedEnvelope): NormalizedItem {
  const extracted = profile === 'incident-io' ? extractIncidentIo(env.rawBody) : extractAtlassianStatuspage(env.rawBody);
  // 공급자 형식이 바뀌어 단계 추출에 실패해도 일반 피드로 처리해 항목을 보존한다.
  if (!extracted) return normalizeGeneric(env);

  const title = cleanTitle(env.title);
  const item: NormalizedItem = {
    atomId: env.atomId,
    title,
    link: env.link,
    summary: extracted.summary,
    incidentStage: extracted.stage,
    contentHash: computeIncidentContentHash({ stage: extracted.stage, summary: extracted.summary })
  };

  copyFeedMetadata(item, env);
  return item;
}

function extractIncidentIo(rawBody: string): IncidentUpdate | undefined {
  const match = INCIDENT_IO_STATUS_RE.exec(rawBody);
  if (!match?.[1]) return undefined;

  const stage = normalizeIncidentStage(match[1]);
  if (!stage) return undefined;

  const afterMarker = rawBody.slice(match.index + match[0].length);
  const summary = cleanSummary(afterMarker || rawBody);
  if (!summary) return undefined;
  return { stage, summary };
}

function extractAtlassianStatuspage(rawBody: string): IncidentUpdate | undefined {
  // 누적 이력 전체가 아니라 맨 앞의 최신 문단만 변경 감지에 사용한다.
  const paragraph = PARAGRAPH_RE.exec(rawBody)?.[0];
  if (!paragraph) return undefined;

  const stageText = STRONG_STAGE_RE.exec(paragraph)?.[1];
  if (!stageText) return undefined;

  const stage = normalizeIncidentStage(stageText);
  const summary = cleanSummary(paragraph);
  if (!stage || !summary) return undefined;
  return { stage, summary };
}

function normalizeIncidentStage(value: string): IncidentStage | undefined {
  const normalized = htmlToText(value, { singleLine: true, maxChars: undefined });
  if (!normalized) return undefined;

  const known = INCIDENT_STAGES.find((stage) => stage.toLowerCase() === normalized.toLowerCase());
  return known ?? normalized;
}

export function normalize(profile: Profile, env: FeedEnvelope): NormalizedItem {
  // 공급자별 처리가 실패하면 일반 정규화를 시도한다. 일반 처리의 실패까지 숨기지는 않는다.
  try {
    if (profile === 'incident-io' || profile === 'atlassian-statuspage') {
      return normalizeIncident(profile, env);
    }
    return normalizeGeneric(env);
  } catch {
    return normalizeGeneric(env);
  }
}

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

const INCIDENT_IO_GENERATOR_RE = /<generator\b[^>]*>\s*incident\.io\s*<\/generator>/i;

const ATLASSIAN_STATUSPAGE_MARKERS = [
  /statuspage\.io/i,
  /status\.io/i,
  /status\.atlassian\.com/i,
  /Statuspage/i
];

const INCIDENT_IO_STATUS_MARKER_RE = /<(?:b|strong)\b[^>]*>\s*Status:\s*[^<]+<\/(?:b|strong)>/i;

const ATLASSIAN_SEGMENT_MARKER_RE = /<p\b[^>]*>[\s\S]*?<strong\b[^>]*>\s*(?:Investigating|Identified|Monitoring|Resolved|Update)\s*<\/strong>[\s\S]*?<\/p>/i;

export function effectiveProfile(profileSetting: SourceProfile, detectedProfile?: Profile | null): Profile {
  // 관리자가 지정한 프로필은 자동 감지 결과보다 우선한다.
  if (profileSetting !== 'auto') return profileSetting;
  return detectedProfile ?? 'generic';
}

export function detectProfile(rawXml: string, envelopes: readonly FeedEnvelope[] = []): Profile {
  if (INCIDENT_IO_GENERATOR_RE.test(rawXml)) return 'incident-io';
  if (ATLASSIAN_STATUSPAGE_MARKERS.some((marker) => marker.test(rawXml))) return 'atlassian-statuspage';

  // XML과 본문에서 검사할 범위를 제한해 큰 피드에서도 탐지 비용을 제한한다.
  const bodySample = envelopes
    .slice(0, 200)
    .map((envelope) => `${envelope.title}\n${envelope.rawBody}`)
    .join('\n');
  const sample = `${rawXml.slice(0, 250_000)}\n${bodySample}`;

  if (INCIDENT_IO_STATUS_MARKER_RE.test(sample)) return 'incident-io';
  if (ATLASSIAN_SEGMENT_MARKER_RE.test(sample)) return 'atlassian-statuspage';
  return 'generic';
}
