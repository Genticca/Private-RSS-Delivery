/**
 * 입력 검증 기본 함수. 미입력(undefined)과 명시적 비우기(null/빈 목록)의 의미를 구분한다.
 */
import { validationError, SecurityError } from './errors.js';

/** 공백뿐이거나 값이 없으면 null을 반환하고, 내용이 있는 문자열은 원문을 유지한다. */
export function blankToNull(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && value.trim() !== '' ? value : null;
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationError('요청 본문이 올바르지 않습니다.');
  }
  return value as Record<string, unknown>;
}

/** undefined는 기존 값 유지, null·빈 문자열은 비우기를 뜻한다. 유효 문자열만 길이를 검사한다. */
export function optionalString(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  if (text.length > maxLength) throw validationError('입력 값이 너무 깁니다.', { [field]: `${maxLength}자 이하로 입력하세요.` });
  return text;
}

/** 선택 문자열의 정규화 결과가 비어 있으면 필드별 필수 입력 오류로 바꾼다. */
export function requiredString(value: unknown, field: string, maxLength: number): string {
  const text = optionalString(value, field, maxLength);
  if (!text) throw validationError('필수 값이 누락되었습니다.', { [field]: '필수 값입니다.' });
  return text;
}

/** JSON 값과 HTML 폼의 on/off 표현을 같은 boolean 계약으로 해석한다. */
export function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(text)) return true;
  if (['false', '0', 'off', 'no', ''].includes(text)) return false;
  throw validationError('boolean 값이 필요합니다.');
}

/** 입력이 있을 때만 정수·범위를 검사해 PATCH의 미입력 유지 의미를 보존한다. */
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

/** Discord snowflake는 안전 정수 범위를 넘을 수 있으므로 숫자로 변환하지 않는다. */
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

interface StringListOptions {
  maxItems: number;
  numericOnly: boolean;
}

/** 배열·쉼표 문자열·JSON 배열을 한 목록으로 만들고 중복 제거 전후의 개수 제한을 검사한다. */
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

/** 외부 주소 검증 오류를 폼이 표시할 필드 오류로 바꾸되 보안 차단 코드는 유지한다. */
export function securityValidationError(error: unknown, field: string): Error {
  if (error instanceof SecurityError) {
    const code = error.code === 'webhook_not_allowed' || error.code === 'ssrf_blocked'
      ? error.code
      : 'validation_error';
    return validationError(error.message, { [field]: code });
  }
  return validationError('URL이 올바르지 않습니다.', { [field]: 'invalid_url' });
}
