import process from 'node:process';

export const MODEL_API_KEY_ENV = 'PRIMARY_MODEL_API_KEY';
export const FALLBACK_MODEL_API_KEY_ENV = 'FALLBACK_MODEL_API_KEY';
export const MODEL_NAME_ENV = 'GEMINI_MODEL';
export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

const MODEL_PATTERN = /^gemini-[a-z0-9][a-z0-9._-]*$/i;

/** Gemini API 키를 환경 변수에서만 읽는다. 키 원문은 DB나 관리 화면 응답에 포함하지 않는다. */
export function resolveModelApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[MODEL_API_KEY_ENV]?.trim();
  return value && value.length > 0 ? value : null;
}

export interface ModelCredential {
  slot: 'primary' | 'fallback';
  apiKey: string;
}

/** 빈 키와 중복 키를 제외하고 기본 키 → 대체 키 순서로 반환한다. 원문은 통신에만 사용한다. */
export function resolveModelCredentials(env: NodeJS.ProcessEnv = process.env): ModelCredential[] {
  const primary = resolveModelApiKey(env);
  const fallback = env[FALLBACK_MODEL_API_KEY_ENV]?.trim() || null;
  const credentials: ModelCredential[] = [];
  if (primary) credentials.push({ slot: 'primary', apiKey: primary });
  if (fallback && fallback !== primary) credentials.push({ slot: 'fallback', apiKey: fallback });
  return credentials;
}

/** 번역 모델 이름을 환경 변수에서 읽는다. 비우면 기본 모델이고, gemini-* 형식이 아니면 기동을 멈춘다. */
export function resolveModelName(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[MODEL_NAME_ENV]?.trim();
  if (!value) return DEFAULT_MODEL;
  if (!MODEL_PATTERN.test(value)) throw new Error(`${MODEL_NAME_ENV} must be a gemini-* model name.`);
  return value;
}
