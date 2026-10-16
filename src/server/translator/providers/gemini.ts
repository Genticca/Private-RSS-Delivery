import { GoogleGenAI } from '@google/genai';
import type { TranslationProvider, TranslationProviderRequest, TranslationProviderResponse } from '../types.js';

export class GeminiTranslationProvider implements TranslationProvider {
  async generate(request: TranslationProviderRequest): Promise<TranslationProviderResponse> {
    const ai = new GoogleGenAI({ apiKey: request.apiKey });
    const response = await ai.models.generateContent({
      model: request.config.model,
      contents: request.prompt,
      config: {
        abortSignal: request.signal,
        responseJsonSchema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title', 'summary'] },
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
