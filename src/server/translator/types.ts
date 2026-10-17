export interface TranslationInput {
  itemId?: number;
  jobId?: number;
  title: string;
  summary: string;
}

/** translated가 false이면 title·summary는 번역 실패 시 사용할 원문이다. */
export interface TranslationResult {
  title: string;
  summary: string;
  translated: boolean;
}

export interface TranslationProviderRequest {
  apiKey: string;
  model: string;
  prompt: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface TranslationProviderResponse {
  text: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  finishReason?: string | null;
}

/** 공급자는 통신과 응답 매핑을 담당하고, 실패 처리와 기록은 ModelTranslator에 맡긴다. */
export interface TranslationProvider {
  generate(request: TranslationProviderRequest): Promise<TranslationProviderResponse>;
}

export class TranslationProviderError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'TranslationProviderError';
  }
}
