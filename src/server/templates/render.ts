/**
 * Discord 템플릿 렌더. 저장 항목·정규화 항목을 공통 문맥으로 바꾸고 JSON 렌더 결과를 검증한다.
 */
import Handlebars from 'handlebars';
import type { SourceProfile, NormalizedItem, Profile } from '../feed/parse.js';
import type { ItemRecord } from '../feed/repository.js';
import { effectiveProfile } from '../feed/normalize.js';
import { validateDiscordPayload } from './payload.js';

export interface PresetRenderItem extends NormalizedItem {
  publishedAtFormatted?: string;
}

export interface PresetRenderSource {
  id: string;
  name: string;
  feedUrl?: string;
  profile?: Profile;
}

export interface PresetRenderContext {
  // Discord 프리셋에 공개하는 입력만 모은다. DB 레코드 전체를 템플릿에 노출하지 않는다.
  item: PresetRenderItem;
  source: PresetRenderSource;
}

export const PRESET_VARIABLES = [
  'item.title',
  'item.link',
  'item.summary',
  'item.publishedAtFormatted',
  'item.author',
  'source.name',
  'item.incidentStage',
  'item.commentsUrl',
  'item.image',
  'source.feedUrl',
  'source.profile'
] as const;

export const PRESET_HELPERS = ['truncate', 'stageColor', 'stageLabel', 'eq', 'json'] as const;

export type PresetVariable = (typeof PRESET_VARIABLES)[number];

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedFooter {
  text: string;
  icon_url?: string;
}

export interface DiscordEmbedAuthor {
  name: string;
  url?: string;
  icon_url?: string;
}

export interface DiscordEmbedMedia {
  url: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: DiscordEmbedFooter;
  author?: DiscordEmbedAuthor;
  thumbnail?: DiscordEmbedMedia;
  image?: DiscordEmbedMedia;
  timestamp?: string;
}

export interface DiscordWebhookPayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  flags?: number;
  thread_name?: string;
  applied_tags?: string[];
  embeds?: DiscordEmbed[];
  allowed_mentions?: {
    parse?: Array<'roles' | 'users' | 'everyone'>;
    roles?: string[];
    users?: string[];
    replied_user?: boolean;
  };
}

const handlebars = Handlebars.create();

let helpersRegistered = false;

export class PresetRenderError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PresetRenderError';
  }
}

export interface BuildPresetRenderContextOptions {
  useTranslationCache?: boolean;
}

/** 발송 직전에 번역 결과를 얹은 항목이다. 번역 결과는 DB 항목에 저장하지 않는다. */
export type TranslatedItem = ItemRecord & {
  translatedTitle?: string | null;
  translatedSummary?: string | null;
};

/** 발송 항목과 미리보기 항목을 같은 템플릿 입력으로 만든다. 번역값 적용 여부는 호출자가 정한다. */
export function buildPresetRenderContext(
  item: TranslatedItem | NormalizedItem,
  source: RenderSource,
  options: BuildPresetRenderContextOptions = {}
): PresetRenderContext {
  const renderItem = isItemRecord(item)
    ? itemRecordToPresetItem(item, options.useTranslationCache ?? true)
    : normalizedItemToPresetItem(item);
  return {
    item: renderItem,
    source: {
      id: source.id,
      name: fallbackSourceName(source),
      feedUrl: source.feedUrl,
      profile: effectiveProfile(source.profileSetting, source.detectedProfile)
    }
  };
}

/** 격리된 Handlebars 엔진의 공통 헬퍼로 렌더링하고 템플릿 예외를 렌더 오류로 감싼다. */
export function renderTemplate(templateBody: string, context: PresetRenderContext): string {
  registerHelpers();
  try {
    return handlebars.compile(disambiguateJsonObjectClosers(templateBody))(context);
  } catch (error) {
    throw new PresetRenderError('Preset template could not be rendered.', error);
  }
}

/** 렌더된 문자열을 JSON으로 읽은 뒤 Discord 자료형·크기 제한까지 확인한다. */
export function renderDiscordPayload(templateBody: string, context: PresetRenderContext): DiscordWebhookPayload {
  const rendered = renderTemplate(templateBody, context);
  let payload: unknown;
  try {
    payload = JSON.parse(rendered);
  } catch (error) {
    throw new PresetRenderError('Preset template did not render valid JSON.', error);
  }
  return validateDiscordPayload(payload);
}

/** 서버 운영체제의 시간대와 관계없이 화면용 KST 시각을 만든다. */
export function formatKstTimestamp(value?: string | null): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (KST)`;
}

function disambiguateJsonObjectClosers(templateBody: string): string {
  // 헬퍼의 닫는 중괄호와 JSON의 닫는 중괄호가 붙어 삼중 중괄호로 해석되는 것을 막는다.
  return templateBody.replace(/({{\s*(?:json|stageColor|stageLabel|truncate|eq)\b[^{}]*}})(?=})/g, '$1 ');
}

/** 헬퍼를 한 번만 등록한다. JSON 값은 이스케이프된 HTML이 아닌 JSON 문법으로 출력한다. */
function registerHelpers(): void {
  if (helpersRegistered) return;
  helpersRegistered = true;
  handlebars.registerHelper('truncate', (value: unknown, maxLength: unknown) => truncateText(toText(value), Number(maxLength)));
  handlebars.registerHelper('stageColor', (stage: unknown) => stageColor(toText(stage)));
  handlebars.registerHelper(
    'stageLabel',
    (stage: unknown) => new handlebars.SafeString(JSON.stringify(stageLabel(toText(stage))))
  );
  handlebars.registerHelper('eq', (left: unknown, right: unknown) => left === right);
  handlebars.registerHelper('json', (value: unknown) => new handlebars.SafeString(JSON.stringify(value ?? '')));
}

function truncateText(text: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) return '';
  const limit = Math.floor(maxLength);
  if (text.length <= limit) return text;
  if (limit <= 3) return text.slice(0, limit);
  const rawCut = text.slice(0, limit - 3).trimEnd();
  const boundary = rawCut.lastIndexOf(' ');
  const cut = boundary >= Math.floor(rawCut.length * 0.6) ? rawCut.slice(0, boundary).trimEnd() : rawCut;
  return `${cut}...`;
}

// 진행 단계 한국어 표시 라벨. 정규화는 stage 를 영어 표준형으로 고정(해시 안정), 한국어화는 렌더 계층의
// 결정적 매핑으로만 처리한다(AI 번역 제외 — 번역 입력은 title/summary 뿐, prompt 도 stage 라벨 보존 지시).
// 매핑에 없는 원문(예: 현지화된 statuspage 의 'Incidente')은 그대로 통과시킨다.
const INCIDENT_STAGE_LABELS_KO: Record<string, string> = {
  Investigating: '조사 중',
  Identified: '원인 확인',
  Monitoring: '모니터링 중',
  Resolved: '해결됨',
  Update: '업데이트'
};

function stageLabel(stage: string): string {
  return INCIDENT_STAGE_LABELS_KO[stage] ?? stage;
}

function stageColor(stage: string): number {
  if (stage === 'Resolved') return 5763719;
  if (stage === 'Investigating' || stage === 'Identified' || stage === 'Monitoring' || stage === 'Update') return 15548997;
  return 9807270;
}

/** 번역 결과가 없는 필드는 원문을 사용하고 DB 전용 필드를 템플릿 문맥에서 제외한다. */
function itemRecordToPresetItem(item: TranslatedItem, useTranslationCache: boolean): PresetRenderItem {
  const publishedAtFormatted = formatKstTimestamp(item.publishedAt ?? item.updatedAt);
  const title = useTranslationCache ? item.translatedTitle ?? item.title ?? '' : item.title ?? '';
  const summary = useTranslationCache ? item.translatedSummary ?? item.summary ?? '' : item.summary ?? '';
  return {
    atomId: item.atomId,
    title,
    link: item.link,
    publishedAt: item.publishedAt ?? undefined,
    updatedAt: item.updatedAt ?? undefined,
    author: item.author ?? undefined,
    commentsUrl: item.commentsUrl ?? undefined,
    image: item.image ?? undefined,
    summary,
    incidentStage: item.incidentStage ?? undefined,
    contentHash: item.contentHash,
    publishedAtFormatted
  };
}

/** 저장 전 미리보기 항목에도 발송과 같은 표시 시각을 덧붙인다. */
function normalizedItemToPresetItem(item: NormalizedItem): PresetRenderItem {
  return {
    ...item,
    publishedAtFormatted: formatKstTimestamp(item.publishedAt ?? item.updatedAt)
  };
}

function isItemRecord(item: TranslatedItem | NormalizedItem): item is TranslatedItem {
  return 'sourceId' in item && 'contentRevision' in item;
}

function fallbackSourceName(source: RenderSource): string {
  const name = source.name?.trim();
  if (name) return name;
  return source.feedUrl || source.id;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export interface RenderSource {
  id: string;
  name: string | null;
  feedUrl: string;
  profileSetting: SourceProfile;
  detectedProfile: Profile | null;
}
