import type Database from 'better-sqlite3';
import { fetch as undiciFetch, type Response } from 'undici';
import type { DiscordWebhookPayload } from '../contracts/render-context.js';
import type { DeliveryFailureReason } from '../db/delivery-log.repository.js';
import type { ItemRecord, SourceRecord, TemplateRecord } from '../db/index.js';
import { addSecondsIso, nowIso } from '../db/time.js';
import type { RepositoryRegistry } from '../runtime/container.js';
import type { DispatchTranslationService } from '../translator/index.js';
import { SecurityError, assertSafeWebhookMessageUrl, assertSafeWebhookUrl, getSsrSafeAgent } from '../security/index.js';
import { applySourceWebhookOptions } from './payload-options.js';
import { buildPresetRenderContext, PresetRenderError, renderDiscordPayload } from './render.js';
import { resolveDestinationsForSource, type DeliveryDestination } from './resolve-destinations.js';
import { DiscordPayloadValidationError, validateDiscordPayload } from './validate.js';

export interface WebhookDispatcherOptions {
  db: Database.Database;
  repositories: RepositoryRegistry;
  postWebhook?: WebhookPostFunction;
  editWebhook?: WebhookEditFunction;
  translationService?: Pick<DispatchTranslationService, 'translateItemForDispatch'>;
  now?: () => string;
  dueLimit?: number;
  requestTimeoutMs?: number;
}

export interface WebhookPostRequest {
  destination: DeliveryDestination;
  payload: DiscordWebhookPayload;
  timeoutMs: number;
  captureMessageId?: boolean;
}

export interface WebhookEditRequest {
  destination: DeliveryDestination;
  messageId: string;
  payload: DiscordWebhookPayload;
  timeoutMs: number;
}

export interface WebhookPostResponse {
  statusCode: number;
  retryAfterMs?: number;
  error?: string;
  messageId?: string;
}

export type WebhookPostFunction = (request: WebhookPostRequest) => Promise<WebhookPostResponse>;
export type WebhookEditFunction = (request: WebhookEditRequest) => Promise<WebhookPostResponse>;

export type DeliveryRunOutcome = 'delivered' | 'failed' | 'retrying' | 'skipped';

export interface DeliveryRunResult {
  itemId: number;
  outcome: DeliveryRunOutcome;
  attemptNo: number | null;
  failureReason?: string;
  nextAttemptAt?: string | null;
}

interface DestinationAttempt {
  destination: DeliveryDestination;
  status: 'success' | 'skipped' | 'terminal_failed' | 'transient_failed';
  httpStatus: number | null;
  failureReason: DeliveryFailureReason | null;
  error: string | null;
  renderedBytes: number | null;
  retryAfterMs?: number;
  appendLog: boolean;
  messageId: string | null;
}

const DEFAULT_DUE_LIMIT = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS_BY_FAILURE_COUNT = [0, 60, 120, 240, 480] as const;

export class WebhookDispatcher {
  private readonly inFlightItems = new Set<number>();

  constructor(private readonly options: WebhookDispatcherOptions) {}

  async runDueDeliveries(now = this.now()): Promise<DeliveryRunResult[]> {
    const dueItems = this.options.repositories.items.findDueDeliveries(now, this.options.dueLimit ?? DEFAULT_DUE_LIMIT);
    const results: DeliveryRunResult[] = [];
    for (const item of dueItems) {
      results.push(await this.processItem(item, now));
    }
    return results;
  }

  async processItem(item: ItemRecord, now = this.now()): Promise<DeliveryRunResult> {
    if (this.inFlightItems.has(item.id)) {
      return { itemId: item.id, outcome: 'skipped', attemptNo: null };
    }

    this.inFlightItems.add(item.id);
    try {
      return await this.processItemInternal(item, now);
    } finally {
      this.inFlightItems.delete(item.id);
    }
  }

  private async processItemInternal(item: ItemRecord, now: string): Promise<DeliveryRunResult> {
    const attemptNo = item.attemptCount + 1;
    const source = this.options.repositories.sources.getById(item.sourceId);
    if (!source || !source.enabled) {
      return { itemId: item.id, outcome: 'skipped', attemptNo };
    }

    let destinations: DeliveryDestination[];
    try {
      destinations = resolveDestinationsForSource(source, this.options.repositories);
    } catch (error) {
      if (error instanceof SecurityError) {
        return this.failItem(item, 'guard_blocked', now, attemptNo);
      }
      throw error;
    }

    if (destinations.length === 0) {
      return { itemId: item.id, outcome: 'skipped', attemptNo };
    }

    const template = this.resolveTemplate(source);
    if (!template) {
      return this.failItem(item, 'render', now, attemptNo);
    }

    const renderItem = await this.translateItemForRender(item, source, now);

    let payload: DiscordWebhookPayload;
    try {
      payload = renderDiscordPayload(template.body, buildPresetRenderContext(renderItem, source, { useTranslationCache: source.translate }));
    } catch (error) {
      if (error instanceof DiscordPayloadValidationError) {
        return this.failItem(item, 'validate', now, attemptNo);
      }
      if (error instanceof PresetRenderError) {
        const reason = error.message.includes('valid JSON') ? 'validate' : 'render';
        return this.failItem(item, reason, now, attemptNo);
      }
      return this.failItem(item, 'render', now, attemptNo);
    }

    // 포럼 thread_name 자동생성은 렌더된 제목을 따른다 — 번역 ON이면 번역 제목(render.ts 와 동일 규칙), 아니면 원문.
    const threadNameFallback = source.translate ? renderItem.translatedTitle ?? renderItem.title : renderItem.title;
    const attempts: DestinationAttempt[] = [];
    for (const destination of destinations) {
      attempts.push(await this.attemptDestination(item, source, payload, destination, threadNameFallback));
    }

    return this.commitAttempts(item, attempts, now, attemptNo);
  }

  private async translateItemForRender(item: ItemRecord, source: SourceRecord, now: string): Promise<ItemRecord> {
    if (!source.translate) return item;
    if (!this.options.translationService) return item;
    return this.options.translationService.translateItemForDispatch(item, source, now);
  }

  private resolveTemplate(source: SourceRecord): TemplateRecord | null {
    if (source.templateId !== null) {
      return this.options.repositories.templates.getById(source.templateId);
    }
    return this.options.repositories.templates.findByName('minimal');
  }

  private async attemptDestination(
    item: ItemRecord,
    source: SourceRecord,
    payload: DiscordWebhookPayload,
    destination: DeliveryDestination,
    threadNameFallback: string | null
  ): Promise<DestinationAttempt> {
    let destinationPayload: DiscordWebhookPayload;
    let renderedBytes: number;
    try {
      destinationPayload = validateDiscordPayload(
        withDestinationOverrides(applySourceWebhookOptions(payload, source, threadNameFallback), destination)
      );
      renderedBytes = Buffer.byteLength(JSON.stringify(destinationPayload), 'utf8');
    } catch (error) {
      if (error instanceof DiscordPayloadValidationError) {
        return {
          destination,
          status: 'terminal_failed',
          httpStatus: null,
          failureReason: 'validate',
          error: error.message,
          renderedBytes: null,
          appendLog: true,
          messageId: null
        };
      }
      throw error;
    }

    const resolved = this.options.repositories.deliveryLogs.findResolved(item.id, destination.destinationKey, item.contentHash);
    if (resolved?.status === 'success') {
      return {
        destination,
        status: 'skipped',
        httpStatus: null,
        failureReason: null,
        error: null,
        renderedBytes,
        appendLog: true,
        messageId: resolved.discordMessageId
      };
    }
    if (resolved && this.options.repositories.deliveryLogs.isTerminalFailure(resolved.failureReason)) {
      return {
        destination,
        status: 'terminal_failed',
        httpStatus: resolved.httpStatus,
        failureReason: resolved.failureReason as DeliveryFailureReason,
        error: null,
        renderedBytes: null,
        appendLog: false,
        messageId: null
      };
    }

    let response: WebhookPostResponse;
    try {
      assertSafeWebhookUrl(destination.webhookUrl);
      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const priorMessageId = source.editInPlace
        ? this.options.repositories.deliveryLogs.findLatestMessageId(item.id, destination.destinationKey)
        : null;
      if (priorMessageId) {
        const editResponse = await this.editWebhook({
          destination,
          messageId: priorMessageId,
          payload: destinationPayload,
          timeoutMs
        });
        response = editResponse.statusCode === 404
          ? await this.postWebhook({
              destination,
              payload: destinationPayload,
              timeoutMs,
              captureMessageId: true
            })
          : { ...editResponse, messageId: editResponse.messageId ?? priorMessageId };
      } else {
        response = await this.postWebhook({
          destination,
          payload: destinationPayload,
          timeoutMs,
          captureMessageId: source.editInPlace
        });
      }
    } catch (error) {
      if (error instanceof SecurityError) {
        return {
          destination,
          status: 'terminal_failed',
          httpStatus: null,
          failureReason: 'guard_blocked',
          error: error.message,
          renderedBytes,
          appendLog: true,
          messageId: null
        };
      }
      return {
        destination,
        status: 'transient_failed',
        httpStatus: null,
        failureReason: 'network',
        error: formatError(error),
        renderedBytes,
        appendLog: true,
        messageId: null
      };
    }

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return {
        destination,
        status: 'success',
        httpStatus: response.statusCode,
        failureReason: null,
        error: null,
        renderedBytes,
        appendLog: true,
        messageId: response.messageId ?? null
      };
    }

    if (response.statusCode === 429) {
      return {
        destination,
        status: 'transient_failed',
        httpStatus: response.statusCode,
        failureReason: 'rate_limited',
        error: response.error ?? 'Discord webhook rate limited the request.',
        renderedBytes,
        retryAfterMs: response.retryAfterMs,
        appendLog: true,
        messageId: null
      };
    }

    if (response.statusCode >= 500) {
      return {
        destination,
        status: 'transient_failed',
        httpStatus: response.statusCode,
        failureReason: 'network',
        error: response.error ?? `Discord webhook returned HTTP ${response.statusCode}.`,
        renderedBytes,
        appendLog: true,
        messageId: null
      };
    }

    return {
      destination,
      status: 'terminal_failed',
      httpStatus: response.statusCode,
      failureReason: 'webhook_rejected',
      error: response.error ?? `Discord webhook rejected the request with HTTP ${response.statusCode}.`,
      renderedBytes,
      appendLog: true,
      messageId: null
    };
  }

  private commitAttempts(
    item: ItemRecord,
    attempts: readonly DestinationAttempt[],
    now: string,
    attemptNo: number
  ): DeliveryRunResult {
    return this.transaction(() => {
      for (const attempt of attempts) {
        if (!attempt.appendLog) continue;
        this.options.repositories.deliveryLogs.append({
          itemId: item.id,
          attemptNo,
          status: logStatusForAttempt(attempt),
          httpStatus: attempt.httpStatus,
          error: attempt.error,
          renderedBytes: attempt.renderedBytes,
          destinationKey: attempt.destination.destinationKey,
          contentHash: item.contentHash,
          failureReason: attempt.failureReason,
          discordMessageId: attempt.messageId,
          createdAt: now
        });
      }

      const transientFailures = attempts.filter((attempt) => attempt.status === 'transient_failed');
      if (transientFailures.length > 0) {
        const failureCount = this.options.repositories.items.incrementAttempt(item.id);
        if (failureCount >= MAX_ATTEMPTS) {
          this.options.repositories.items.markFailed(item.id, 'max_retries', now);
          return { itemId: item.id, outcome: 'failed', attemptNo, failureReason: 'max_retries', nextAttemptAt: null };
        }
        const nextAttemptAt = addSecondsIso(now, retryDelaySeconds(failureCount, transientFailures));
        this.options.repositories.items.setNextAttempt(item.id, nextAttemptAt);
        return { itemId: item.id, outcome: 'retrying', attemptNo, nextAttemptAt };
      }

      const terminalFailure = attempts.find((attempt) => attempt.status === 'terminal_failed');
      if (terminalFailure) {
        const reason = terminalFailure.failureReason ?? 'webhook_rejected';
        this.options.repositories.items.markFailed(item.id, reason, now);
        return { itemId: item.id, outcome: 'failed', attemptNo, failureReason: reason, nextAttemptAt: null };
      }

      this.options.repositories.items.markDelivered(item.id, now);
      return { itemId: item.id, outcome: 'delivered', attemptNo, nextAttemptAt: null };
    });
  }

  private failItem(item: ItemRecord, reason: DeliveryFailureReason, now: string, attemptNo: number): DeliveryRunResult {
    this.transaction(() => {
      this.options.repositories.deliveryLogs.append({
        itemId: item.id,
        attemptNo,
        status: 'failed',
        httpStatus: null,
        error: reason,
        renderedBytes: null,
        destinationKey: null,
        contentHash: item.contentHash,
        failureReason: reason,
        createdAt: now
      });
      this.options.repositories.items.markFailed(item.id, reason, now);
    });
    return { itemId: item.id, outcome: 'failed', attemptNo, failureReason: reason, nextAttemptAt: null };
  }

  private async postWebhook(request: WebhookPostRequest): Promise<WebhookPostResponse> {
    const postWebhook = this.options.postWebhook ?? postDiscordWebhook;
    return postWebhook(request);
  }

  private async editWebhook(request: WebhookEditRequest): Promise<WebhookPostResponse> {
    const editWebhook = this.options.editWebhook ?? editDiscordWebhookMessage;
    return editWebhook(request);
  }

  private transaction<T>(fn: () => T): T {
    return this.options.db.transaction(fn)();
  }

  private now(): string {
    return this.options.now?.() ?? nowIso();
  }
}

export async function postDiscordWebhook(request: WebhookPostRequest): Promise<WebhookPostResponse> {
  const url = assertSafeWebhookUrl(request.destination.webhookUrl);
  if (request.destination.threadId) url.searchParams.set('thread_id', request.destination.threadId);
  if (request.captureMessageId) url.searchParams.set('wait', 'true');
  const response = await undiciFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.payload),
    dispatcher: getSsrSafeAgent(),
    signal: AbortSignal.timeout(request.timeoutMs)
  });
  const messageId = response.ok && request.captureMessageId ? await readDiscordMessageId(response) : undefined;
  const error = response.ok ? undefined : await response.text().then((body) => body.slice(0, 500)).catch(() => undefined);
  return {
    statusCode: response.status,
    retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    error,
    messageId
  };
}

export async function editDiscordWebhookMessage(request: WebhookEditRequest): Promise<WebhookPostResponse> {
  const baseUrl = assertSafeWebhookUrl(request.destination.webhookUrl);
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/messages/${request.messageId}`;
  if (request.destination.threadId) baseUrl.searchParams.set('thread_id', request.destination.threadId);
  const url = assertSafeWebhookMessageUrl(baseUrl.toString());
  const response = await undiciFetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.payload),
    dispatcher: getSsrSafeAgent(),
    signal: AbortSignal.timeout(request.timeoutMs)
  });
  const error = response.ok ? undefined : await response.text().then((body) => body.slice(0, 500)).catch(() => undefined);
  return {
    statusCode: response.status,
    retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
    error,
    messageId: response.ok ? request.messageId : undefined
  };
}

async function readDiscordMessageId(response: Response): Promise<string | undefined> {
  const body = await response.json().catch(() => null) as { id?: unknown } | null;
  return typeof body?.id === 'string' && /^\d+$/.test(body.id) ? body.id : undefined;
}

function withDestinationOverrides(payload: DiscordWebhookPayload, destination: DeliveryDestination): DiscordWebhookPayload {
  return {
    ...payload,
    username: destination.webhookName ?? payload.username,
    avatar_url: destination.webhookAvatarUrl ?? payload.avatar_url
  };
}

function logStatusForAttempt(attempt: DestinationAttempt): 'success' | 'failed' | 'skipped' {
  if (attempt.status === 'success') return 'success';
  if (attempt.status === 'skipped') return 'skipped';
  return 'failed';
}

function retryDelaySeconds(failureCount: number, transientFailures: readonly DestinationAttempt[]): number {
  const retryAfterSeconds = Math.max(
    0,
    ...transientFailures.map((attempt) => (attempt.retryAfterMs === undefined ? 0 : Math.ceil(attempt.retryAfterMs / 1000)))
  );
  const backoffSeconds = BACKOFF_SECONDS_BY_FAILURE_COUNT[failureCount] ?? BACKOFF_SECONDS_BY_FAILURE_COUNT.at(-1) ?? 480;
  return Math.max(retryAfterSeconds, backoffSeconds);
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
