import { fetch as undiciFetch, type Dispatcher, type RequestInfo, type RequestInit, type Response } from 'undici';
import { getSsrSafeAgent } from './agent-cache.js';
import { SecurityError } from './errors.js';
import { assertSafeFeedUrl, verifyFeedUrlSafe, type DnsLookup } from './ip.js';
import type { FetchOptions, TlsMaxVersion } from './types.js';

export interface FeedFetchSource {
  id?: string;
  feedUrl: string;
  etag?: string | null;
  lastModified?: string | null;
  fetchOptions?: FetchOptions;
}

export type FetchImplementation = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export interface FetchFeedOptions {
  fetchImpl?: FetchImplementation;
  dispatcherFactory?: (tlsMaxVersion?: TlsMaxVersion) => Dispatcher;
  lookup?: DnsLookup;
  persistFetchOptions?: (sourceId: string, fetchOptions: FetchOptions) => void | Promise<void>;
}

export type FeedFetchResult =
  | {
      kind: 'not-modified';
      statusCode: 304;
      url: string;
      etag: string | null;
      lastModified: string | null;
      usedTlsMaxVersion?: TlsMaxVersion;
      persistedFetchOptions?: FetchOptions;
    }
  | {
      kind: 'ok';
      statusCode: number;
      url: string;
      body: string;
      etag: string | null;
      lastModified: string | null;
      contentType: string | null;
      charset: string;
      usedTlsMaxVersion?: TlsMaxVersion;
      persistedFetchOptions?: FetchOptions;
    };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = 'rss-discord-bridge/0.4.0';
const DEFAULT_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';
const MAX_REDIRECTS = 3;

export async function fetchFeed(source: FeedFetchSource, options: FetchFeedOptions = {}): Promise<FeedFetchResult> {
  const url = assertSafeFeedUrl(source.feedUrl);
  await verifyFeedUrlSafe(source.feedUrl, { lookup: options.lookup });

  const fetchOptions = source.fetchOptions ?? {};
  const firstAttempt = await attemptFetch(source, fetchOptions.tlsMaxVersion, options);
  if (firstAttempt.retryWithTls12) {
    const retryAttempt = await attemptFetch(source, 'TLSv1.2', options);
    if (retryAttempt.retryWithTls12) {
      throw new SecurityError('fetch_failed', 'TLSv1.2 retry requested another retry.');
    }
    const persistedFetchOptions = { ...fetchOptions, tlsMaxVersion: 'TLSv1.2' as const };
    if (source.id && options.persistFetchOptions) {
      await options.persistFetchOptions(source.id, persistedFetchOptions);
    }
    return { ...retryAttempt.result, url: url.toString(), usedTlsMaxVersion: 'TLSv1.2', persistedFetchOptions };
  }
  return { ...firstAttempt.result, url: url.toString() };
}

async function attemptFetch(
  source: FeedFetchSource,
  tlsMaxVersion: TlsMaxVersion | undefined,
  options: FetchFeedOptions
): Promise<{ result: FeedFetchResult; retryWithTls12: false } | { retryWithTls12: true }> {
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  const dispatcher =
    options.dispatcherFactory?.(tlsMaxVersion) ??
    getSsrSafeAgent({ tlsMaxVersion, lookup: options.lookup });
  const timeoutMs = source.fetchOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();

  const headers = buildHeaders(source);
  let currentUrl = source.feedUrl;
  let redirectCount = 0;

  let response: Response;
  try {
    response = await fetchImpl(currentUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      dispatcher,
      signal: controller.signal
    });

    while (isRedirect(response.status)) {
      const location = header(response, 'location');
      await discardBody(response);
      if (!location) {
        throw new SecurityError('http_error', 'Feed redirect did not include a location header.', {
          statusCode: response.status
        });
      }
      if (redirectCount >= MAX_REDIRECTS) {
        throw new SecurityError('redirect_blocked', 'Too many feed redirects.', {
          statusCode: response.status,
          maxRedirects: MAX_REDIRECTS
        });
      }
      redirectCount += 1;

      const targetUrl = new URL(location, currentUrl).toString();
      assertSafeFeedUrl(targetUrl);
      await verifyFeedUrlSafe(targetUrl, { lookup: options.lookup });
      currentUrl = targetUrl;

      response = await fetchImpl(currentUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        dispatcher,
        signal: controller.signal
      });
    }
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof SecurityError) {
      throw error;
    }
    if (!tlsMaxVersion && isTlsHandshakeError(error)) {
      return { retryWithTls12: true };
    }
    throw mapFetchError(error);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 304) {
    await discardBody(response);
    return {
      retryWithTls12: false,
      result: {
        kind: 'not-modified',
        statusCode: 304,
        url: source.feedUrl,
        etag: header(response, 'etag'),
        lastModified: header(response, 'last-modified'),
        usedTlsMaxVersion: tlsMaxVersion
      }
    };
  }

  if (response.status === 403 && !tlsMaxVersion) {
    await discardBody(response);
    return { retryWithTls12: true };
  }

  if (!response.ok) {
    await discardBody(response);
    throw new SecurityError('http_error', `Feed fetch failed with HTTP ${response.status}.`, {
      statusCode: response.status
    });
  }

  const contentType = header(response, 'content-type');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const charset = selectCharset(source.fetchOptions, contentType, bytes);
  return {
    retryWithTls12: false,
    result: {
      kind: 'ok',
      statusCode: response.status,
      url: source.feedUrl,
      body: decodeBytes(bytes, charset),
      etag: header(response, 'etag'),
      lastModified: header(response, 'last-modified'),
      contentType,
      charset,
      usedTlsMaxVersion: tlsMaxVersion
    }
  };
}

function buildHeaders(source: FeedFetchSource): Record<string, string> {
  const fetchOptions = source.fetchOptions ?? {};
  const headers: Record<string, string> = {
    accept: DEFAULT_ACCEPT,
    'user-agent': fetchOptions.userAgent ?? DEFAULT_USER_AGENT,
    ...normalizeHeaders(fetchOptions.headers)
  };
  if (source.etag) headers['if-none-match'] = source.etag;
  if (source.lastModified) headers['if-modified-since'] = source.lastModified;
  return headers;
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name, value]) => name.trim() !== '' && value.trim() !== '')
      .map(([name, value]) => [name.toLowerCase(), value])
  );
}

function selectCharset(fetchOptions: FetchOptions | undefined, contentType: string | null, bytes: Uint8Array): string {
  return (
    normalizeCharset(fetchOptions?.charset) ??
    normalizeCharset(charsetFromContentType(contentType)) ??
    normalizeCharset(charsetFromXmlDeclaration(bytes)) ??
    'utf-8'
  );
}

function charsetFromContentType(contentType: string | null): string | undefined {
  if (!contentType) return undefined;
  return /(?:^|;)\s*charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/^["']|["']$/g, '');
}

function charsetFromXmlDeclaration(bytes: Uint8Array): string | undefined {
  const preview = new TextDecoder('latin1').decode(bytes.slice(0, 512));
  return /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(preview)?.[1];
}

function normalizeCharset(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'utf8') return 'utf-8';
  if (normalized === 'euckr' || normalized === 'ks-c-5601-1987') return 'euc-kr';
  return normalized;
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    throw new SecurityError('unsupported_charset', `Unsupported response charset: ${charset}.`, { charset });
  }
}

async function discardBody(response: Response): Promise<void> {
  if (!response.body || response.bodyUsed) return;
  try {
    await response.body.cancel();
  } catch {
    // best-effort drain/cancel only
  }
}

function header(response: Response, name: string): string | null {
  return response.headers.get(name);
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function isTlsHandshakeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return /tls|ssl|handshake|certificate/i.test(`${code} ${message}`);
}

function mapFetchError(error: unknown): SecurityError {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout/i.test(message)) {
    return new SecurityError('timeout', 'Feed fetch timed out.');
  }
  return new SecurityError('fetch_failed', 'Feed fetch failed.', { message });
}
