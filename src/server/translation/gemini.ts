/**
 * Gemini 어댑터와 자격 정보 해석. 키는 환경 변수에서 읽고 공급자 응답을 공통 계약으로 변환한다.
 */
import process from 'node:process';
import { GoogleGenAI } from '@google/genai';
import type { TranslationProvider, TranslationProviderRequest, TranslationProviderResponse } from './translator.js';

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

const TRANSLATION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' }
  },
  required: ['title', 'summary']
};

/** Gemini SDK 응답을 공통 번역 응답으로 바꾼다. JSON 구조·최대 출력량·취소 신호도 함께 전달한다. */
export class GeminiTranslationProvider implements TranslationProvider {
  /** 공급자 한 번의 호출만 담당한다. 키 전환과 재시도 판단은 상위 번역기가 소유한다. */
  async generate(request: TranslationProviderRequest): Promise<TranslationProviderResponse> {
    // 키별 재시도·전환은 ModelTranslator에서 담당한다. SDK 내부 재시도는 하지 않는다.
    const ai = new GoogleGenAI({ apiKey: request.apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
    const response = await ai.models.generateContent({
      model: request.model,
      contents: request.prompt,
      config: {
        abortSignal: request.signal,
        responseJsonSchema: TRANSLATION_RESPONSE_SCHEMA,
        temperature: 0,
        maxOutputTokens: request.maxOutputTokens,
        responseMimeType: 'application/json'
      }
    });
    return {
      text: response.text ?? '',
      inputTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      finishReason: response.candidates?.[0]?.finishReason ?? null
    };
  }
}
