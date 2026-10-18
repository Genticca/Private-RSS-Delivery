/**
 * Discord 웹훅 주소 경계. 허용 도메인·경로를 확인하고 비교에 사용할 주소를 정규화한다.
 */
import { SecurityError } from '../core/errors.js';
import { parseHttpUrl, resolveSafeHostname, assertAddressAllowed, type DnsLookup } from './address.js';

const ALLOWED_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com']);

const WEBHOOK_PATH_RE = /^\/api\/webhooks\/[^/]+\/[^/]+\/?$/;

const WEBHOOK_MESSAGE_PATH_RE = /^\/api\/webhooks\/[^/]+\/[^/]+\/messages\/\d+$/;

export interface WebhookGuardOptions {
  lookup?: DnsLookup;
}

/** 웹훅 생성 경로를 검증한다. 메시지 수정 경로의 허용 범위와 구분한다. */
export function assertSafeWebhookUrl(value: string): URL {
  const url = parseDiscordWebhookUrl(value);
  if (!WEBHOOK_PATH_RE.test(url.pathname)) {
    throw new SecurityError('webhook_not_allowed', 'Discord webhook URL path must be /api/webhooks/{id}/{token}.');
  }
  return url;
}

/** 이미 전송한 메시지를 PATCH할 때 사용하는 경로까지 검사한다. */
export function assertSafeWebhookMessageUrl(value: string): URL {
  const url = parseDiscordWebhookUrl(value);
  if (!WEBHOOK_MESSAGE_PATH_RE.test(url.pathname)) {
    throw new SecurityError('webhook_not_allowed', 'Discord webhook message URL path must be /api/webhooks/{id}/{token}/messages/{messageId}.');
  }
  return url;
}

function parseDiscordWebhookUrl(value: string): URL {
  const url = parseHttpUrl(value);
  if (url.protocol !== 'https:') {
    throw new SecurityError('webhook_not_allowed', 'Discord webhook URL must use https.');
  }
  if (url.username || url.password) {
    throw new SecurityError('webhook_not_allowed', 'Discord webhook URL must not contain credentials.');
  }
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_WEBHOOK_HOSTS.has(host)) {
    throw new SecurityError('webhook_not_allowed', 'Only Discord webhook hosts are allowed.');
  }
  return url;
}

/** 허용된 Discord URL인지 확인한 뒤 DNS 결과도 검증한다. */
export async function verifyWebhookUrlSafe(value: string, options: WebhookGuardOptions = {}): Promise<URL> {
  const url = assertSafeWebhookUrl(value);
  const addresses = await resolveSafeHostname(url.hostname, options);
  for (const address of addresses) {
    assertAddressAllowed(address.address);
  }
  return url;
}

/** 목적지 중복 판단을 위해 호스트·경로 표현을 정규화하되 웹훅 토큰의 대소문자는 보존한다. */
export function canonicalWebhookUrl(value: string): string {
  const url = assertSafeWebhookUrl(value);
  const path = url.pathname.replace(/\/+$/, '');
  if (url.hostname === 'discordapp.com') url.hostname = 'discord.com';
  // 토큰의 대소문자는 보존한다. 스레드 설정은 소스에서 관리하므로 쿼리는 식별 키에서 제외한다.
  return `${url.origin}${path}`;
}
