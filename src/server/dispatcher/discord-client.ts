import { fetch as undiciFetch, type Response } from 'undici';
import type { DiscordWebhookPayload } from '../contracts/render-context.js';
import { assertSafeWebhookMessageUrl, assertSafeWebhookUrl, canonicalWebhookUrl, getSsrSafeAgent } from '../security/index.js';
import type { DeliveryDestination } from './resolve-destinations.js';

export interface WebhookPostRequest { destination: DeliveryDestination; payload: DiscordWebhookPayload; timeoutMs: number; captureMessageId?: boolean; }
export interface WebhookEditRequest extends WebhookPostRequest { messageId: string; }
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
  url.searchParams.set('wait', 'true');
  const response = await undiciFetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.payload),
    dispatcher: getSsrSafeAgent(), signal: AbortSignal.timeout(request.timeoutMs)
  });
  const result = await readResponse(response);
  if (result.channelId && request.payload.thread_name && !request.destination.threadId) result.threadId = result.channelId;
  return result;
}

export async function editDiscordWebhookMessage(request: WebhookEditRequest): Promise<WebhookPostResponse> {
  const base = assertSafeWebhookUrl(canonicalWebhookUrl(request.destination.webhookUrl));
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/messages/${request.messageId}`;
  if (request.destination.threadId) base.searchParams.set('thread_id', request.destination.threadId);
  const payload = { ...request.payload };
  delete payload.thread_name;
  delete payload.applied_tags;
  const response = await undiciFetch(assertSafeWebhookMessageUrl(base.toString()), {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    dispatcher: getSsrSafeAgent(), signal: AbortSignal.timeout(request.timeoutMs)
  });
  return { ...await readResponse(response), messageId: response.ok ? request.messageId : undefined };
}

async function readResponse(response: Response): Promise<WebhookPostResponse> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const retrySeconds = Number(response.headers.get('retry-after') ?? body?.retry_after ?? 1);
  const resetSeconds = Number(response.headers.get('x-ratelimit-reset-after') ?? 0);
  return {
    statusCode: response.status,
    messageId: snowflake(body?.id), channelId: snowflake(body?.channel_id),
    retryAfterMs: Number.isFinite(retrySeconds) ? Math.max(1000, retrySeconds * 1000) : 1000,
    cooldownMs: response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(resetSeconds) ? Math.max(0, resetSeconds * 1000) : undefined,
    globalRateLimit: body?.global === true,
    error: response.ok ? undefined : `Discord returned HTTP ${response.status}.`
  };
}

function snowflake(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
}
