import { SecurityError } from './errors.js';
import { assertAddressAllowed, parseHttpUrl, resolveSafeHostname, type DnsLookup } from './ip.js';

const ALLOWED_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com']);
const WEBHOOK_PATH_RE = /^\/api\/webhooks\/[^/]+\/[^/]+\/?$/;
const WEBHOOK_MESSAGE_PATH_RE = /^\/api\/webhooks\/[^/]+\/[^/]+\/messages\/\d+$/;

export interface WebhookGuardOptions {
  lookup?: DnsLookup;
}

export function assertSafeWebhookUrl(value: string): URL {
  const url = parseDiscordWebhookUrl(value);
  if (!WEBHOOK_PATH_RE.test(url.pathname)) {
    throw new SecurityError('webhook_not_allowed', 'Discord webhook URL path must be /api/webhooks/{id}/{token}.');
  }
  return url;
}

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

export async function verifyWebhookUrlSafe(value: string, options: WebhookGuardOptions = {}): Promise<URL> {
  const url = assertSafeWebhookUrl(value);
  const addresses = await resolveSafeHostname(url.hostname, options);
  for (const address of addresses) {
    assertAddressAllowed(address.address);
  }
  return url;
}

export function canonicalWebhookUrl(value: string): string {
  const url = assertSafeWebhookUrl(value);
  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  return `${url.protocol}//${url.hostname.toLowerCase()}${path}`;
}
