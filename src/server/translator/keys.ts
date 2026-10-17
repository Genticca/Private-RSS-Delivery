import process from 'node:process';

export const MODEL_API_KEY_ENV = 'PRIMARY_MODEL_API_KEY';
export const MODEL_NAME_ENV = 'GEMINI_MODEL';
export const DEFAULT_MODEL = 'gemini-3.1-flash-lite';

const MODEL_PATTERN = /^gemini-[a-z0-9][a-z0-9._-]*$/i;

/** Gemini API 키를 환경 변수에서만 읽는다. 키 원문은 DB나 관리 화면 응답에 포함하지 않는다. */
export function resolveModelApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[MODEL_API_KEY_ENV]?.trim();
  return value && value.length > 0 ? value : null;
}

/** 번역 모델 이름을 환경 변수에서 읽는다. 비우면 기본 모델이고, gemini-* 형식이 아니면 기동을 멈춘다. */
export function resolveModelName(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[MODEL_NAME_ENV]?.trim();
  if (!value) return DEFAULT_MODEL;
  if (!MODEL_PATTERN.test(value)) throw new Error(`${MODEL_NAME_ENV} must be a gemini-* model name.`);
  return value;
}
