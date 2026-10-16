import type { ModelConfigRecord } from '../db/index.js';

export interface TranslationInput {
  itemId?: number;
  jobId?: number;
  title: string;
  summary: string;
}

export interface TranslationResult {
  title: string;
  summary: string;
  translated: boolean;
}

export interface TranslationProviderRequest {
  apiKey: string;
  config: ModelConfigRecord;
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

export interface TranslationProvider {
  generate(request: TranslationProviderRequest): Promise<TranslationProviderResponse>;
}

export class TranslationProviderError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = 'TranslationProviderError';
  }
}
