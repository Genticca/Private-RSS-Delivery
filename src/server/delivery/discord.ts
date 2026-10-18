/**
 * Discord HTTP 어댑터. POST·PATCH 전송과 메시지 ID·rate limit 헤더의 공통 응답 매핑을 담당한다.
 */
import { fetch as undiciFetch, type Response } from 'undici';
import type { DiscordWebhookPayload } from '../templates/render.js';
import { assertSafeWebhookUrl, canonicalWebhookUrl, assertSafeWebhookMessageUrl } from '../net/webhook-url.js';
import { getSsrSafeAgent } from '../net/fetch.js';
import type { DeliveryDestination } from './bindings.js';

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

/** 새 메시지를 전송한다. 원본 메시지 ID가 필요한 요청은 wait 응답을 받아 영수증을 확보한다. */
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

/** 보관된 원본 메시지 ID를 대상으로 수정한다. 기존 스레드 대상을 함께 유지한다. */
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

/** 타임아웃과 안전한 Agent를 적용하고 응답 본문·제한 헤더를 공통 결과로 매핑한다. */
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

/** 응답 JSON을 읽을 수 없는 경우에도 HTTP 상태와 헤더 정보는 유지한다. */
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

/** Discord 식별자는 숫자 연산 없이 문자열로 검증·반환한다. */
function snowflake(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : undefined;
}
