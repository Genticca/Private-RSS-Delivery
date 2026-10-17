import type { DeliveryDestination } from './resolve-destinations.js';
import type { DiscordWebhookPayload } from '../contracts/render-context.js';
import { assertSafeWebhookUrl } from '../net/webhook-url.js';
import { canonicalWebhookUrl } from '../net/webhook-url.js';
import { assertSafeWebhookMessageUrl } from '../net/webhook-url.js';
import type { Response } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { getSsrSafeAgent } from '../net/fetch.js';

export interface WebhookPostRequest {
  destination: DeliveryDestination;
  payload: DiscordWebhookPayload;
  timeoutMs: number;
  captureMessageId?: boolean;
}

export interface WebhookEditRequest extends WebhookPostRequest {
  messageId: string;
}

export interface WebhookPostResponse {
  statusCode: number;
  retryAfterMs?: number;
  cooldownMs?: number;
  globalRateLimit?: boolean;
  error?: string;
  messageId?: string;
  channelId?: string;
  threadId?: string;
}

export type WebhookPostFunction = (request: WebhookPostRequest) => Promise<WebhookPostResponse>;

export type WebhookEditFunction = (request: WebhookEditRequest) => Promise<WebhookPostResponse>;

export async function postDiscordWebhook(request: WebhookPostRequest): Promise<WebhookPostResponse> {
  const url = assertSafeWebhookUrl(canonicalWebhookUrl(request.destination.webhookUrl));
  if (request.destination.threadId) url.searchParams.set('thread_id', request.destination.threadId);
  // 성공 응답에서 메시지 ID를 받아 이후 편집할 대상을 확정한다.
  url.searchParams.set('wait', 'true');
  const response = await sendWebhookRequest(url, 'POST', request.payload, request.timeoutMs);
  const result = await readResponse(response);
  if (result.channelId && request.payload.thread_name && !request.destination.threadId) result.threadId = result.channelId;
  return result;
}

export async function editDiscordWebhookMessage(request: WebhookEditRequest): Promise<WebhookPostResponse> {
  const messageUrl = assertSafeWebhookUrl(canonicalWebhookUrl(request.destination.webhookUrl));
  messageUrl.pathname = `${messageUrl.pathname.replace(/\/+$/, '')}/messages/${request.messageId}`;
  if (request.destination.threadId) messageUrl.searchParams.set('thread_id', request.destination.threadId);
  // 새 스레드 생성 옵션은 기존 메시지 편집 요청에 포함하지 않는다.
  const payload = { ...request.payload };
  delete payload.thread_name;
  delete payload.applied_tags;
  const response = await sendWebhookRequest(
    assertSafeWebhookMessageUrl(messageUrl.toString()), 'PATCH', payload, request.timeoutMs
  );
  return { ...await readResponse(response), messageId: response.ok ? request.messageId : undefined };
}

function sendWebhookRequest(
  url: URL,
  method: 'POST' | 'PATCH',
  payload: DiscordWebhookPayload,
  timeoutMs: number
): Promise<Response> {
  return undiciFetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    dispatcher: getSsrSafeAgent(),
    signal: AbortSignal.timeout(timeoutMs)
  });
}

async function readResponse(response: Response): Promise<WebhookPostResponse> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const retrySeconds = Number(response.headers.get('retry-after') ?? body?.retry_after ?? 1);
  const resetSeconds = Number(response.headers.get('x-ratelimit-reset-after') ?? 0);
  const retryAfterMs = Number.isFinite(retrySeconds) ? Math.max(1000, retrySeconds * 1000) : 1000;
  const hasExhaustedBucket = response.headers.get('x-ratelimit-remaining') === '0';
  const cooldownMs = hasExhaustedBucket && Number.isFinite(resetSeconds)
    ? Math.max(0, resetSeconds * 1000)
    : undefined;
  return {
    statusCode: response.status,
    messageId: snowflake(body?.id),
    channelId: snowflake(body?.channel_id),
    retryAfterMs,
    cooldownMs,
    globalRateLimit: body?.global === true,
    error: response.ok ? undefined : `Discord returned HTTP ${response.status}.`
  };
}

function snowflake(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
}
