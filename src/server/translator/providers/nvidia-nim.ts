import { fetch as undiciFetch } from 'undici';
import { TRANSLATION_SYSTEM_PROMPT } from '../prompt.js';
import { TranslationProviderError, type TranslationProvider, type TranslationProviderRequest, type TranslationProviderResponse } from '../types.js';

const NIM_CHAT_COMPLETIONS_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

export class NvidiaNimTranslationProvider implements TranslationProvider {
  async generate(request: TranslationProviderRequest): Promise<TranslationProviderResponse> {
    const response = await undiciFetch(NIM_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        'content-type': 'application/json'
      },
      signal: request.signal,
      body: JSON.stringify({
        model: request.config.model,
        messages: [
          { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
          { role: 'user', content: request.prompt }
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: request.maxOutputTokens
      })
    });

    const body = (await response.text()).slice(0, 1_000_000);
    if (!response.ok) {
      throw new TranslationProviderError(`NVIDIA NIM returned HTTP ${response.status}.`, response.status);
    }

    const json = JSON.parse(body) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      inputTokens: json.usage?.prompt_tokens ?? null,
      outputTokens: json.usage?.completion_tokens ?? null,
      finishReason: choice?.finish_reason ?? null
    };
  }
}
