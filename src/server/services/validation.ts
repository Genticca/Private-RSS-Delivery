import type { ModelProvider, SourceId } from '../contracts/api.js';
import { PROFILES, SOURCE_PROFILE_OPTIONS, type SourceProfile } from '../domain/normalize/types.js';
import type { FetchOptions } from '../security/types.js';
import { assertSafeFeedUrl, assertSafeWebhookUrl, parseHttpUrl, SecurityError } from '../security/index.js';
import { validationError } from './errors.js';

const MODEL_PROVIDERS = new Set<ModelProvider>(['gemini']);

export function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationError('요청 본문이 올바르지 않습니다.');
  }
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  if (text.length > maxLength) throw validationError('입력 값이 너무 깁니다.', { [field]: `${maxLength}자 이하로 입력하세요.` });
  return text;
}

export function requiredString(value: unknown, field: string, maxLength: number): string {
  const text = optionalString(value, field, maxLength);
  if (!text) throw validationError('필수 값이 누락되었습니다.', { [field]: '필수 값입니다.' });
  return text;
}

export { blankToNull } from '../domain/text.js';

export function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(text)) return true;
  if (['false', '0', 'off', 'no', ''].includes(text)) return false;
  throw validationError('boolean 값이 필요합니다.');
}

export function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw validationError('정수 범위를 벗어났습니다.', { [field]: `${min}~${max} 사이의 정수를 입력하세요.` });
  }
  return parsed;
}

export function parseIdParam(value: unknown, field = 'id'): number {
  const parsed = Number(String(value));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw validationError('id가 올바르지 않습니다.', { [field]: '양의 정수여야 합니다.' });
  }
  return parsed;
}

export function parseSourceId(value: unknown): SourceId {
  const text = String(value ?? '').trim();
  if (!text) throw validationError('source id가 올바르지 않습니다.', { id: '필수 값입니다.' });
  return text;
}

export function parseSourceProfile(value: unknown): SourceProfile | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!(SOURCE_PROFILE_OPTIONS as readonly string[]).includes(text)) {
    throw validationError('profile 값이 올바르지 않습니다.', { profile: SOURCE_PROFILE_OPTIONS.join(', ') });
  }
  return text as SourceProfile;
}

export function parseDiscordId(value: unknown, field: string): string | null | undefined {
  // Discord ID는 JavaScript의 안전한 정수 범위를 넘을 수 있어 문자열로 유지한다.
  const text = optionalString(value, field, 64);
  if (text === undefined || text === null) return text;
  if (!/^\d+$/.test(text)) {
    throw validationError('Discord ID 값이 올바르지 않습니다.', { [field]: '숫자 문자열이어야 합니다.' });
  }
  return text;
}

export function parseDiscordIdList(value: unknown, field: string, maxItems = Number.MAX_SAFE_INTEGER): string[] | undefined {
  return parseStringList(value, field, { maxItems, numericOnly: true });
}

export function parseDiscordTagIds(value: unknown, field: string, maxItems = 5): string[] | undefined {
  return parseStringList(value, field, { maxItems, numericOnly: true });
}

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

interface StringListOptions {
  maxItems: number;
  numericOnly: boolean;
}

function parseStringList(value: unknown, field: string, options: StringListOptions): string[] | undefined {
  // JSON 배열, 쉼표 구분 문자열, 폼의 반복 필드를 동일한 목록으로 정규화한다.
  if (value === undefined) return undefined;
  if (value === null || value === '') return [];
  let raw: unknown[];
  if (Array.isArray(value)) {
    raw = value;
  } else {
    const text = String(value).trim();
    if (!text) return [];
    if (text.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error('not array');
        raw = parsed;
      } catch {
        throw validationError(`${field} JSON이 올바르지 않습니다.`, { [field]: '문자열 배열이어야 합니다.' });
      }
    } else {
      raw = text.split(',');
    }
  }
  if (raw.length > options.maxItems) {
    throw validationError('배열 항목이 너무 많습니다.', { [field]: `${options.maxItems}개 이하로 입력하세요.` });
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const text = String(item).trim();
    if (!text) continue;
    if (options.numericOnly && !/^\d+$/.test(text)) {
      throw validationError(`${field} 값이 올바르지 않습니다.`, { [field]: '숫자 문자열 배열이어야 합니다.' });
    }
    if (!seen.has(text)) {
      seen.add(text);
      output.push(text);
    }
  }
  if (output.length > options.maxItems) {
    throw validationError('배열 항목이 너무 많습니다.', { [field]: `${options.maxItems}개 이하로 입력하세요.` });
  }
  return output;
}

export function validateFeedUrl(value: unknown): string {
  const feedUrl = requiredString(value, 'feedUrl', 2048);
  try {
    return assertSafeFeedUrl(feedUrl).toString();
  } catch (error) {
    throw mapSecurityValidation(error, 'feedUrl');
  }
}

export function validateOptionalWebhookUrl(value: unknown): string | null | undefined {
  const webhookUrl = optionalString(value, 'webhookUrl', 2048);
  if (webhookUrl === undefined || webhookUrl === null) return webhookUrl;
  try {
    return assertSafeWebhookUrl(webhookUrl).toString();
  } catch (error) {
    throw mapSecurityValidation(error, 'webhookUrl');
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

export function validateProvider(value: unknown): ModelProvider | undefined {
  if (value === undefined) return undefined;
  const provider = String(value).trim() as ModelProvider;
  if (!MODEL_PROVIDERS.has(provider)) {
    throw validationError('provider 값이 올바르지 않습니다.', { provider: 'gemini만 허용됩니다.' });
  }
  return provider;
}

export function knownProfiles(): string[] {
  return [...PROFILES];
}

function mapSecurityValidation(error: unknown, field: string): Error {
  if (error instanceof SecurityError) {
    const code = error.code === 'webhook_not_allowed' || error.code === 'ssrf_blocked'
      ? error.code
      : 'validation_error';
    return validationError(error.message, { [field]: code });
  }
  return validationError('URL이 올바르지 않습니다.', { [field]: 'invalid_url' });
}
