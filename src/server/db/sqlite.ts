export function toSqliteBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function fromSqliteBoolean(value: number): boolean {
  return value === 1;
}

export function nullable<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

export function parseJsonObject<T extends object>(value: string | null, fallback: T, fieldName: string): T {
  // 값이 없는 경우만 기본값을 사용한다. 손상된 JSON은 필드명을 포함한 오류로 드러낸다.
  if (value === null || value.trim() === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('JSON value is not an object.');
    }
    return parsed as T;
  } catch (error) {
    throw new Error(`${fieldName} contains invalid JSON.`, { cause: error });
  }
}

export function stringifyJsonObject(value: object): string {
  return JSON.stringify(value);
}

export function parseJsonStringArray(value: string | null, fallback: string[], fieldName: string): string[] {
  if (value === null || value.trim() === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('JSON value is not a string array.');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${fieldName} contains invalid JSON.`, { cause: error });
  }
}

export function stringifyJsonStringArray(value: readonly string[]): string {
  return JSON.stringify(value);
}

export function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must not be empty.`);
  }
  return trimmed;
}
