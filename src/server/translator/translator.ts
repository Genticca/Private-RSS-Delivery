import type { EventLogRepository, ItemRecord, SourceRecord, TranslationCacheRepository } from '../db/index.js';
import type { TranslatedItem } from '../dispatcher/render.js';
import { TranslationCacheService } from './translation-cache.service.js';
import { nowIso } from '../db/time.js';
import { DEFAULT_MODEL, resolveModelApiKey } from './keys.js';
import { buildTranslationPrompt, parseTranslationResponse, TARGET_LANG } from './prompt.js';
import { GeminiTranslationProvider } from './providers/gemini.js';
import type { TranslationInput, TranslationProvider, TranslationProviderResponse, TranslationResult } from './types.js';
import { TranslationProviderError } from './types.js';

export interface ModelTranslatorOptions {
  repositories: {
    eventLog: Pick<EventLogRepository, 'append'>
  };
  env?: NodeJS.ProcessEnv;
  /** GEMINI_MODEL 환경 변수에서 읽은 모델 이름(resolveModelName). */
  model?: string;
  provider?: TranslationProvider;
  now?: () => string;
  maxOutputTokens?: number;
  providerTimeoutMs?: number;
}

export interface DispatchTranslationServiceOptions {
  repositories: {
    translationCache: TranslationCacheRepository;
    eventLog: Pick<EventLogRepository, 'append'>
  };
  translator: Pick<ModelTranslator, 'translate'>;
  now?: () => string;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 1200;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

export class ModelTranslator {
  private readonly provider: TranslationProvider;

  constructor(private readonly options: ModelTranslatorOptions) {
    this.provider = options.provider ?? new GeminiTranslationProvider();
  }

  async translate(input: TranslationInput): Promise<TranslationResult> {
    // 번역 모델은 Gemini 하나다. 키 없음, 통신 실패, 잘림, 형식 오류는 모두 원문으로 끝낸다.
    const apiKey = resolveModelApiKey(this.options.env);
    if (!apiKey) {
      this.record(input, 'skipped', 'missing-key');
      return originalTextResult(input);
    }

    const prompt = buildTranslationPrompt({ ...input, targetLang: TARGET_LANG });
    const startedMs = Date.now();
    let response: TranslationProviderResponse;
    try {
      response = await withTimeout(
        (signal) => this.provider.generate({
          apiKey,
          model: this.options.model ?? DEFAULT_MODEL,
          prompt,
          maxOutputTokens: this.options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
          signal
        }),
        this.options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
      );
    } catch (error) {
      this.record(input, 'failed', classifyError(error), startedMs);
      return originalTextResult(input);
    }

    if (isLengthFinish(response.finishReason)) {
      this.record(input, 'failed', 'length', startedMs);
      return originalTextResult(input);
    }
    try {
      const parsed = parseTranslationResponse(response.text);
      this.record(input, 'success', null, startedMs);
      return { title: parsed.title, summary: parsed.summary, translated: true };
    } catch (error) {
      this.record(input, 'failed', classifyError(error), startedMs);
      return originalTextResult(input);
    }
  }

  private record(input: TranslationInput, status: 'success' | 'failed' | 'skipped', detail: string | null, startedMs?: number): void {
    this.options.repositories.eventLog.append({
      kind: 'translation',
      status,
      itemId: input.itemId,
      jobId: input.jobId,
      durationMs: startedMs === undefined ? null : Math.max(0, Date.now() - startedMs),
      detail,
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

  async translateItemForDispatch(
    item: ItemRecord,
    source: SourceRecord,
    now = this.now(),
    context: {
      templateBody?: string;
      jobId?: number
    } = {}
  ): Promise<TranslatedItem> {
    if (!source.translate) return item;
    const result = await this.cache.translate(item, source, { ...context, now });
    return {
      ...item,
      translatedTitle: result.title,
      translatedSummary: result.summary
    };
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}


function originalTextResult(input: TranslationInput): TranslationResult {
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
    // 타임아웃 이후 공급자의 요청이 늦게 실패해도 미처리 Promise 거부가 남지 않게 한다.
    operation.catch(() => undefined);
  }
}

function isLengthFinish(value: string | null | undefined): boolean {
  if (!value) return false;
  const reason = value.toLowerCase();
  return reason === 'length' || reason === 'max_tokens';
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
    const status = (error as {
      status?: unknown;
      statusCode?: unknown
    }).status ?? (error as {
      statusCode?: unknown
    }).statusCode;
    if (typeof status === 'number' && Number.isInteger(status)) return status;
  }
  return null;
}
