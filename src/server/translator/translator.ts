import type { EventLogRepository, ItemRecord, SourceRecord, TranslationCacheRepository } from '../db/index.js';
import type { TranslatedItem } from '../dispatcher/render.js';
import type { ModelKeyDiagnostics } from '../contracts/api.js';
import { TranslationCacheService } from './translation-cache.service.js';
import { nowIso } from '../db/time.js';
import { DEFAULT_MODEL, resolveModelCredentials, type ModelCredential } from './keys.js';
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
  keyCooldownMs?: number;
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
const DEFAULT_KEY_COOLDOWN_MS = 300_000;

export class ModelTranslator {
  private readonly provider: TranslationProvider;
  private readonly keyCooldowns = new Map<ModelCredential['slot'], number>();

  constructor(private readonly options: ModelTranslatorOptions) {
    this.provider = options.provider ?? new GeminiTranslationProvider();
  }

  async translate(input: TranslationInput): Promise<TranslationResult> {
    const credentials = resolveModelCredentials(this.options.env);
    if (credentials.length === 0) {
      this.record(input, 'skipped', 'missing-key');
      return originalTextResult(input);
    }

    const prompt = buildTranslationPrompt({ ...input, targetLang: TARGET_LANG });
    let attempted = false;
    for (const { slot, apiKey } of credentials) {
      if ((this.keyCooldowns.get(slot) ?? 0) > Date.parse(this.now())) continue;
      attempted = true;
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
        const failure = classifyError(error);
        this.record(input, 'failed', failure, startedMs, slot);
        // 요청 자체의 400·404 등은 키 교체로 해결되지 않는다. 키·통신 장애만 전환한다.
        if (!canSwitchKey(error, failure)) return originalTextResult(input);
        this.keyCooldowns.set(slot, Date.parse(this.now()) + (this.options.keyCooldownMs ?? DEFAULT_KEY_COOLDOWN_MS));
        continue;
      }

      if (isLengthFinish(response.finishReason)) {
        this.record(input, 'failed', 'length', startedMs, slot);
        return originalTextResult(input);
      }
      try {
        const parsed = parseTranslationResponse(response.text);
        this.keyCooldowns.delete(slot);
        this.record(input, 'success', null, startedMs, slot);
        return { title: parsed.title, summary: parsed.summary, translated: true };
      } catch (error) {
        this.record(input, 'failed', classifyError(error), startedMs, slot);
        return originalTextResult(input);
      }
    }
    if (!attempted) this.record(input, 'skipped', 'keys-cooldown');
    return originalTextResult(input);
  }

  /** API 키 원문 없이 사용 가능 상태와 다음 요청의 키 슬롯만 공개한다. */
  getKeyStatus(): ModelKeyDiagnostics {
    const credentials = resolveModelCredentials(this.options.env);
    const now = Date.parse(this.now());
    const state = (slot: ModelCredential['slot']): ModelKeyDiagnostics['primary'] => {
      if (!credentials.some((credential) => credential.slot === slot)) return { state: 'missing', retryAt: null };
      const until = this.keyCooldowns.get(slot) ?? 0;
      return until > now ? { state: 'cooldown', retryAt: new Date(until).toISOString() } : { state: 'ready', retryAt: null };
    };
    const primary = state('primary');
    const fallback = state('fallback');
    return { primary, fallback, activeKey: primary.state === 'ready' ? 'primary' : fallback.state === 'ready' ? 'fallback' : null };
  }

  private record(input: TranslationInput, status: 'success' | 'failed' | 'skipped', detail: string | null, startedMs?: number, slot: ModelCredential['slot'] = 'primary'): void {
    this.options.repositories.eventLog.append({
      kind: 'translation',
      status,
      itemId: input.itemId,
      jobId: input.jobId,
      durationMs: startedMs === undefined ? null : Math.max(0, Date.now() - startedMs),
      detail: slot === 'fallback' ? `fallback:${detail ?? status}` : detail,
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
  if (status === 401 || status === 403 || (status === 400 && error instanceof Error && /API_KEY_INVALID|API key not valid/i.test(error.message))) return 'invalid-key';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate-limited';
  if (status !== null && status >= 500) return 'provider-error';
  if (error instanceof SyntaxError) return 'parse';
  if (error instanceof Error && /json|title|summary/i.test(error.message)) return 'parse';
  return 'provider-error';
}

function canSwitchKey(error: unknown, failure: string): boolean {
  if (failure === 'invalid-key' || failure === 'timeout' || failure === 'rate-limited') return true;
  const status = statusFromError(error);
  return failure === 'provider-error' && (status === null || status === 408 || status >= 500);
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
