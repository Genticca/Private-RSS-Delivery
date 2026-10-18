/**
 * 소스 전용 입력 경계. 생성 기본값과 수정 시 미입력 유지 규칙을 적용하고 URL·요청 옵션을 검증한다.
 */
import {
  requireObject,
  optionalString,
  optionalInteger,
  optionalBoolean,
  parseDiscordIdList,
  parseDiscordId,
  parseDiscordTagIds,
  requiredString,
  securityValidationError
} from '../core/input.js';
import { SOURCE_PROFILE_OPTIONS, type SourceProfile } from '../feed/parse.js';
import { validationError, SecurityError } from '../core/errors.js';
import { assertSafeFeedUrl, parseHttpUrl } from '../net/address.js';
import type { FetchOptions } from '../net/fetch.js';
import type { CreateSourceRequest, UpdateSourceRequest } from './service.js';

/** 생성 입력의 필수 URL과 선택 옵션을 정규화한다. 업무 기본값은 서비스가 적용한다. */
export function normalizeSourceCreate(value: unknown): Required<Pick<CreateSourceRequest, 'feedUrl'>> & CreateSourceRequest {
  const body = requireObject(value);
  return {
    feedUrl: validateFeedUrl(body.feedUrl),
    name: optionalString(body.name, 'name', 200),
    profile: parseSourceProfile(body.profile),
    pollIntervalSeconds: optionalInteger(body.pollIntervalSeconds, 'pollIntervalSeconds', 60, 86400),
    translate: optionalBoolean(body.translate),
    templateId: optionalInteger(body.templateId, 'templateId', 1, Number.MAX_SAFE_INTEGER) ?? null,
    webhookName: optionalString(body.webhookName, 'webhookName', 80),
    webhookAvatarUrl: validateOptionalHttpUrl(body.webhookAvatarUrl, 'webhookAvatarUrl', 2048),
    fetchOptions: validateFetchOptions(body.fetchOptions),
    groupIds: parseGroupIds(body.groupIds),
    silent: optionalBoolean(body.silent),
    mentionRoleIds: parseDiscordIdList(body.mentionRoleIds, 'mentionRoleIds'),
    mentionUserIds: parseDiscordIdList(body.mentionUserIds, 'mentionUserIds'),
    mentionEveryone: optionalBoolean(body.mentionEveryone),
    mentionHere: optionalBoolean(body.mentionHere),
    threadId: parseDiscordId(body.threadId, 'threadId'),
    threadName: optionalString(body.threadName, 'threadName', 100),
    appliedTags: parseDiscordTagIds(body.appliedTags, 'appliedTags', 5),
    editInPlace: optionalBoolean(body.editInPlace)
  };
}

/** 제공된 필드만 수정 대상으로 남겨 빈 값과 미입력의 차이를 보존한다. */
export function normalizeSourceUpdate(value: unknown): UpdateSourceRequest {
  // undefined는 기존 값 유지, null은 명시적 비우기다. 부분 수정에서 두 값을 구분한다.
  const body = requireObject(value);
  return {
    feedUrl: body.feedUrl === undefined ? undefined : validateFeedUrl(body.feedUrl),
    name: optionalString(body.name, 'name', 200),
    profile: parseSourceProfile(body.profile),
    pollIntervalSeconds: optionalInteger(body.pollIntervalSeconds, 'pollIntervalSeconds', 60, 86400),
    translate: optionalBoolean(body.translate),
    templateId: body.templateId === null || body.templateId === ''
      ? null
      : optionalInteger(body.templateId, 'templateId', 1, Number.MAX_SAFE_INTEGER),
    webhookName: optionalString(body.webhookName, 'webhookName', 80),
    webhookAvatarUrl: validateOptionalHttpUrl(body.webhookAvatarUrl, 'webhookAvatarUrl', 2048),
    fetchOptions: validateFetchOptions(body.fetchOptions),
    groupIds: parseGroupIds(body.groupIds),
    silent: optionalBoolean(body.silent),
    mentionRoleIds: parseDiscordIdList(body.mentionRoleIds, 'mentionRoleIds'),
    mentionUserIds: parseDiscordIdList(body.mentionUserIds, 'mentionUserIds'),
    mentionEveryone: optionalBoolean(body.mentionEveryone),
    mentionHere: optionalBoolean(body.mentionHere),
    threadId: parseDiscordId(body.threadId, 'threadId'),
    threadName: optionalString(body.threadName, 'threadName', 100),
    appliedTags: parseDiscordTagIds(body.appliedTags, 'appliedTags', 5),
    editInPlace: optionalBoolean(body.editInPlace)
  };
}

/** 수동 프로필과 auto만 허용하고 허용 목록을 필드 오류에 함께 안내한다. */
export function parseSourceProfile(value: unknown): SourceProfile | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!(SOURCE_PROFILE_OPTIONS as readonly string[]).includes(text)) {
    throw validationError('profile 값이 올바르지 않습니다.', { profile: SOURCE_PROFILE_OPTIONS.join(', ') });
  }
  return text as SourceProfile;
}

/** 배정 그룹 ID를 양의 정수 목록으로 바꾸고 중복 제거 후 정렬한다. */
export function parseGroupIds(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const ids: number[] = [];
  for (const item of raw) {
    const text = String(item).trim();
    if (!text) continue;
    const parsed = Number(text);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw validationError('groupIds 값이 올바르지 않습니다.', { groupIds: '양의 정수 배열이어야 합니다.' });
    }
    ids.push(parsed);
  }
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

/** URL 구문·리터럴 주소를 검증한다. 비동기 DNS 확인은 저장 전에 서비스가 수행한다. */
export function validateFeedUrl(value: unknown): string {
  const feedUrl = requiredString(value, 'feedUrl', 2048);
  try {
    return assertSafeFeedUrl(feedUrl).toString();
  } catch (error) {
    throw securityValidationError(error, 'feedUrl');
  }
}

export function validateOptionalHttpUrl(value: unknown, field: string, maxLength = 2048): string | null | undefined {
  const httpUrl = optionalString(value, field, maxLength);
  if (httpUrl === undefined || httpUrl === null) return httpUrl;
  try {
    return parseHttpUrl(httpUrl).toString();
  } catch (error) {
    if (error instanceof SecurityError) {
      throw validationError(error.message, { [field]: error.code === 'invalid_url' ? 'invalid_url' : error.code });
    }
    throw validationError('URL이 올바르지 않습니다.', { [field]: 'invalid_url' });
  }
}

/** 문자셋·헤더·TLS·타임아웃을 허용된 구조로 정규화하고 범위를 벗어난 값은 거부한다. */
export function validateFetchOptions(value: unknown): FetchOptions | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    try {
      return validateFetchOptions(JSON.parse(value));
    } catch {
      throw validationError('fetchOptions JSON이 올바르지 않습니다.', { fetchOptions: 'JSON 객체여야 합니다.' });
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('fetchOptions가 올바르지 않습니다.', { fetchOptions: '객체여야 합니다.' });
  }
  const input = value as Record<string, unknown>;
  const output: FetchOptions = {};
  const charset = optionalString(input.charset, 'charset', 64);
  const userAgent = optionalString(input.userAgent, 'userAgent', 256);
  const tlsMaxVersion = optionalString(input.tlsMaxVersion, 'tlsMaxVersion', 16);
  const timeoutMs = optionalInteger(input.timeoutMs, 'timeoutMs', 1000, 120000);
  const headers = validateHeaders(input.headers);
  if (charset) output.charset = charset;
  if (userAgent) output.userAgent = userAgent;
  if (headers) output.headers = headers;
  if (tlsMaxVersion) {
    if (tlsMaxVersion !== 'TLSv1.2' && tlsMaxVersion !== 'TLSv1.3') {
      throw validationError('tlsMaxVersion 값이 올바르지 않습니다.', { tlsMaxVersion: 'TLSv1.2 또는 TLSv1.3만 허용됩니다.' });
    }
    output.tlsMaxVersion = tlsMaxVersion;
  }
  if (timeoutMs !== undefined) output.timeoutMs = timeoutMs;
  return output;
}

/** 헤더 개수·이름·값 길이를 제한하고 줄바꿈이 포함된 값은 허용하지 않는다. */
function validateHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('headers가 올바르지 않습니다.', { headers: '객체여야 합니다.' });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw validationError('headers가 너무 많습니다.', { headers: '20개 이하로 입력하세요.' });
  const output: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim().toLowerCase();
    const headerValue = optionalString(rawValue, `headers.${rawName}`, 1000);
    if (!name || headerValue === undefined || headerValue === null) continue;
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
      throw validationError('header 이름이 올바르지 않습니다.', { headers: rawName });
    }
    if (/[\r\n]/.test(headerValue)) {
      throw validationError('header 값이 올바르지 않습니다.', { headers: `${rawName}에 줄바꿈을 넣을 수 없습니다.` });
    }
    output[name] = headerValue;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}
