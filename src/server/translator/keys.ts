import process from 'node:process';

export const MODEL_API_KEY_ENV = 'PRIMARY_MODEL_API_KEY';

/** Gemini API 키를 환경 변수에서만 읽는다. 키 원문은 DB나 관리 화면 응답에 포함하지 않는다. */
export function resolveModelApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[MODEL_API_KEY_ENV]?.trim();
  return value && value.length > 0 ? value : null;
}
