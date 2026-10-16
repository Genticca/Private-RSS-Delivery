import type { ModelProvider, ModelRole } from '../contracts/api.js';
import type { ItemRecord, ModelConfigRecord, ModelConfigRepository, ModelUsageRepository, SourceRecord, ItemRepository, TranslationCacheRepository } from '../db/index.js';
import { TranslationCacheService } from './translation-cache.service.js';
import { nowIso } from '../db/time.js';
import { resolveModelApiKey } from './keys.js';
import { buildPromptLog, buildTranslationPrompt, parseTranslationResponse } from './prompt.js';
import { GeminiTranslationProvider } from './providers/gemini.js';
import { NvidiaNimTranslationProvider } from './providers/nvidia-nim.js';
import type { TranslationInput, TranslationProvider, TranslationProviderResponse, TranslationResult } from './types.js';
import { TranslationProviderError } from './types.js';

export interface ModelTranslatorRepositories {
  modelConfig: Pick<ModelConfigRepository, 'getByRole'>;
  modelUsage: Pick<ModelUsageRepository, 'append'>;
}

export interface DispatchTranslationRepositories {
  items: Pick<ItemRepository, 'saveTranslationIfCurrent'>;
  translationCache: TranslationCacheRepository;
  modelConfig: Pick<ModelConfigRepository, 'getByRole'>;
}

export interface ModelTranslatorOptions {
  repositories: ModelTranslatorRepositories;
  env?: NodeJS.ProcessEnv;
  providers?: Partial<Record<ModelProvider, TranslationProvider>>;
  now?: () => string;
  maxOutputTokens?: number;
  providerTimeoutMs?: number;
}

export interface DispatchTranslationServiceOptions {
  repositories: DispatchTranslationRepositories;
  translator: Pick<ModelTranslator, 'translate'>;
  now?: () => string;
}

const ROLE_ORDER: readonly ModelRole[] = ['primary', 'fallback'];
const DEFAULT_MAX_OUTPUT_TOKENS = 1200;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

export class ModelTranslator {
  private readonly providers: Record<ModelProvider, TranslationProvider>;

  constructor(private readonly options: ModelTranslatorOptions) {
    this.providers = {
      gemini: new GeminiTranslationProvider(),
      'nvidia-nim': new NvidiaNimTranslationProvider(),
      ...options.providers
    };
  }

  async translate(input: TranslationInput): Promise<TranslationResult> {
    for (const role of ROLE_ORDER) {
      const config = this.options.repositories.modelConfig.getByRole(role);
      if (!config) continue;
      if (!config.enabled) {
        this.recordUsageError(config, 'disabled', input, 'disabled');
        continue;
      }

      const apiKey = resolveModelApiKey(role, this.options.env);
      if (!apiKey) {
        this.recordUsageError(config, 'missing-key', input, 'missing-key');
        continue;
      }

      const prompt = buildTranslationPrompt({ ...input, targetLang: config.targetLang });
      const startedMs = Date.now();
      let response: TranslationProviderResponse | null = null;
      try {
        response = await withTimeout(
          (signal) => this.providers[config.provider].generate({
            apiKey,
            config,
            prompt,
            maxOutputTokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            signal
          }),
          this.options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
        );

        if (isLengthFinish(response.finishReason)) {
          this.recordUsage(config, { input, output: response.text, response, startedMs, error: 'length' });
          return original(input);
        }

        let parsed;
        try {
          parsed = parseTranslationResponse(response.text);
        } catch (error) {
          this.recordUsage(config, { input, output: response.text, response, startedMs, error: classifyError(error) });
          return original(input);
        }
        this.recordUsage(config, { input, output: response.text, response, startedMs });
        return { title: parsed.title, summary: parsed.summary, translated: true };
      } catch (error) {
        const errorCode = classifyError(error);
        this.recordUsage(config, {
          input,
          output: response?.text ?? errorCode,
          response: response ?? undefined,
          startedMs,
          error: errorCode
        });
      }
    }

    return original(input);
  }

  private recordUsageError(config: ModelConfigRecord, error: string, input: TranslationInput, output: string): void {
    const promptLog = buildPromptLog({ ...input, targetLang: config.targetLang }, output, config.promptLogMaxBytes);
    this.options.repositories.modelUsage.append({
      role: config.role,
      provider: config.provider,
      model: config.model,
      error,
      httpRequested: false,
      itemId: input.itemId,
      jobId: input.jobId,
      promptLog,
      createdAt: this.now()
    });
  }

  private recordUsage(
    config: ModelConfigRecord,
    params: {
      input: TranslationInput;
      output: string;
      response?: TranslationProviderResponse;
      startedMs: number;
      error?: string;
    }
  ): void {
    const promptLog = buildPromptLog({ ...params.input, targetLang: config.targetLang }, params.output, config.promptLogMaxBytes);
    this.options.repositories.modelUsage.append({
      role: config.role,
      provider: config.provider,
      model: config.model,
      inputTokens: params.response?.inputTokens ?? null,
      outputTokens: params.response?.outputTokens ?? null,
      latencyMs: Math.max(0, Date.now() - params.startedMs),
      error: params.error ?? null,
      httpRequested: true,
      itemId: params.input.itemId,
      jobId: params.input.jobId,
      promptLog,
      createdAt: this.now()
    });
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}

export class DispatchTranslationService {
  private readonly cache: TranslationCacheService;
  constructor(private readonly options: DispatchTranslationServiceOptions) {
    this.cache = new TranslationCacheService(options);
  }

  async translateItemForDispatch(item: ItemRecord, source: SourceRecord, now = this.now(), context: { templateBody?: string; jobId?: number } = {}): Promise<ItemRecord> {
    if (!source.translate) return item;
    const result = await this.cache.translate(item, source, { ...context, now });
    if (result.translated && result.fields.length > 0) this.options.repositories.items.saveTranslationIfCurrent(item, result.title, result.summary, now);
    return { ...item, translatedTitle: result.title, translatedSummary: result.summary, translatedAt: result.translated ? now : null };
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}


function original(input: TranslationInput): TranslationResult {
  return { title: input.title, summary: input.summary, translated: false };
}

class TranslationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Translation provider timed out after ${timeoutMs}ms.`);
    this.name = 'TranslationTimeoutError';
  }
}

async function withTimeout<T>(operationFactory: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = operationFactory(controller.signal);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TranslationTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    operation.catch(() => undefined);
  }
}

function isLengthFinish(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase() === 'length' || value.toLowerCase() === 'max_tokens';
}

function classifyError(error: unknown): string {
  if (error instanceof TranslationTimeoutError) return 'timeout';
  const status = statusFromError(error);
  if (status === 401 || status === 403) return 'invalid-key';
  if (status === 429) return 'rate-limited';
  if (status !== null && status >= 500) return 'provider-error';
  if (error instanceof SyntaxError) return 'parse';
  if (error instanceof Error && /json|title|summary/i.test(error.message)) return 'parse';
  return 'provider-error';
}

function statusFromError(error: unknown): number | null {
  if (error instanceof TranslationProviderError && error.statusCode !== undefined) return error.statusCode;
  if (error && typeof error === 'object') {
    const status = (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && Number.isInteger(status)) return status;
  }
  return null;
}
