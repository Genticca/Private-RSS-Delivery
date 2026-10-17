import { GoogleGenAI } from '@google/genai';
import type { TranslationProvider, TranslationProviderRequest, TranslationProviderResponse } from '../types.js';

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
  async generate(request: TranslationProviderRequest): Promise<TranslationProviderResponse> {
    const ai = new GoogleGenAI({ apiKey: request.apiKey });
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
