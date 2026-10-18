/**
 * 번역 실행과 키 전환. Gemini 응답을 검증하고 실패한 키를 잠시 제외하며 최종 실패 시 원문을 반환한다.
 */
import type { EventLogRepository } from '../logs/repository.js';
import { nowIso } from '../core/db.js';
import type { ItemRecord } from '../feed/repository.js';
import type { SourceRecord } from '../sources/repository.js';
import type { TranslatedItem } from '../templates/render.js';
import { TranslationCacheService, type TranslationCacheRepository } from './cache.js';
import { GeminiTranslationProvider, resolveModelCredentials, DEFAULT_MODEL, type ModelCredential } from './gemini.js';

export interface ModelKeyDiagnostics {
  /** 대기 중이 아닌 키 중 다음 요청에 사용할 우선순위가 가장 높은 슬롯. */
  activeKey: 'primary' | 'fallback' | null;
  primary: { state: 'missing' | 'ready' | 'cooldown'; retryAt: string | null };
  fallback: { state: 'missing' | 'ready' | 'cooldown'; retryAt: string | null };
}

/** 번역 대상 언어는 한국어로 고정한다. */
export const TARGET_LANG = 'ko';

export interface TranslationPromptInput {
  title: string;
  summary: string;
  targetLang: string;
}

export interface ParsedTranslation {
  title: string;
  summary: string;
}

/** 제목과 본문을 서로 독립된 입력으로 번역하도록 요청하고 URL·식별자 보존 규칙을 함께 전달한다. */
export function buildTranslationPrompt(input: TranslationPromptInput): string {
  return JSON.stringify({
    instruction: `Translate title and summary to ${input.targetLang}. Translate each field independently without using the other field as context. Preserve URLs, CVE IDs, product names, versions, and incident stage labels.`,
    title: input.title,
    summary: input.summary
  });
}

/** 공급자가 반환한 JSON에 title·summary 문자열이 모두 있는지 확인한다. */
export function parseTranslationResponse(value: string): ParsedTranslation {
  const parsed = JSON.parse(extractJsonObject(value)) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Translation response must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.title !== 'string' || typeof record.summary !== 'string') {
    throw new Error('Translation response must include string title and summary.');
  }
  return { title: record.title, summary: record.summary };
}

function extractJsonObject(value: string): string {
  // 모델이 코드 블록이나 설명을 덧붙여도 JSON 객체 부분을 추출해 검증한다.
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error('Translation response did not contain a JSON object.');
}

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

/** 키별 대기 상태를 메모리에서 관리한다. 같은 요청은 사용 가능한 기본 키부터 대체 키 순서로 시도한다. */
export class ModelTranslator {
  private readonly provider: TranslationProvider;
  private readonly keyCooldowns = new Map<ModelCredential['slot'], number>();

  constructor(private readonly options: ModelTranslatorOptions) {
    this.provider = options.provider ?? new GeminiTranslationProvider();
  }

  /** 통신·인증·한도 오류만 키 전환 대상으로 삼고 형식·길이 오류는 원문으로 종료한다. */
  async translate(input: TranslationInput): Promise<TranslationResult> {
    const credentials = resolveModelCredentials(this.options.env);
    if (credentials.length === 0) {
      this.record(input, 'skipped', 'missing-key');
      return originalTextResult(input);
    }

    const prompt = buildTranslationPrompt({ ...input, targetLang: TARGET_LANG });
    let attempted = false;
    // 호출마다 기본 키부터 확인하되, 실패 후 대기 중인 슬롯은 건너뛴다. 대기가 끝나면 기본 키를 다시 시도한다.
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

      // 응답 길이·JSON 형식 문제는 키를 바꿔도 해결되지 않으므로 대체 키를 소모하지 않는다.
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
    return {
      primary,
      fallback,
      activeKey: primary.state === 'ready' ? 'primary' : fallback.state === 'ready' ? 'fallback' : null
    };
  }

  /** 공급자 오류 원문이나 API 키 대신 분류된 실패 사유와 키 슬롯만 기록한다. */
  private record(
    input: TranslationInput,
    status: 'success' | 'failed' | 'skipped',
    detail: string | null,
    startedMs?: number,
    slot: ModelCredential['slot'] = 'primary'
  ): void {
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

/** 발송 전 공유 번역 캐시를 적용해 저장 항목을 바꾸지 않고 전송용 번역 필드만 덧붙인다. */
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

/** 번역 실패·건너뜀에서도 호출자는 원래 제목·본문과 translated=false를 받는다. */
function originalTextResult(input: TranslationInput): TranslationResult {
  return { title: input.title, summary: input.summary, translated: false };
}

class TranslationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Translation provider timed out after ${timeoutMs}ms.`);
    this.name = 'TranslationTimeoutError';
  }
}

/** 취소 신호와 타이머를 공급자 호출에 연결하고, 늦은 실패의 미처리 Promise 거부도 정리한다. */
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

/** 외부 오류를 공개 로그·대체 키 판단에 사용할 안정된 사유 코드로 분류한다. */
function classifyError(error: unknown): string {
  if (error instanceof TranslationTimeoutError) return 'timeout';
  const status = statusFromError(error);
  if (status === 401 || status === 403
    || (status === 400 && error instanceof Error && /API_KEY_INVALID|API key not valid/i.test(error.message)))
    return 'invalid-key';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate-limited';
  if (status !== null && status >= 500) return 'provider-error';
  if (error instanceof SyntaxError) return 'parse';
  if (error instanceof Error && /json|title|summary/i.test(error.message)) return 'parse';
  return 'provider-error';
}

/** 키를 바꾸면 해결될 수 있는 오류만 허용한다. 잘못된 요청·응답은 다른 키로 반복하지 않는다. */
function canSwitchKey(error: unknown, failure: string): boolean {
  if (failure === 'invalid-key' || failure === 'timeout' || failure === 'rate-limited') return true;
  const status = statusFromError(error);
  return failure === 'provider-error' && (status === null || status === 408 || status >= 500);
}

/** SDK와 주입된 공급자가 표현하는 HTTP 상태 필드 차이를 흡수한다. */
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
