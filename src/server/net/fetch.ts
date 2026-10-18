/**
 * 피드 HTTP 전송. 안전한 연결 풀, 리다이렉트 재검증, 응답 크기·시간 제한과 문자셋 처리를 담당한다.
 */
import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInfo,
  type RequestInit,
  type Response
} from 'undici';
import { SecurityError } from '../core/errors.js';
import { tlsProfileKey, createSsrSafeLookup, assertSafeFeedUrl, verifyFeedUrlSafe, type DnsLookup } from './address.js';

export interface AgentCacheOptions {
  tlsMaxVersion?: TlsMaxVersion;
  lookup?: DnsLookup;
}

const cachedAgents = new Map<string, Agent>();

/** TLS 프로필별 기본 연결 풀을 재사용한다. 주입된 DNS 조회는 공유 풀과 격리한다. */
export function getSsrSafeAgent(options: AgentCacheOptions = {}): Dispatcher {
  if (options.lookup) {
    // 주입된 DNS 조회 함수를 사용하는 연결은 기본 DNS 연결 풀과 섞지 않는다.
    return createAgent(options);
  }

  const key = tlsProfileKey(options.tlsMaxVersion);
  const cached = cachedAgents.get(key);
  if (cached && !cached.closed && !cached.destroyed) {
    return cached;
  }

  const agent = createAgent(options);
  cachedAgents.set(key, agent);
  return agent;
}

/** 컨테이너 종료 때 공유 Agent를 닫아 유휴 소켓이 프로세스를 붙잡지 않게 한다. */
export async function closeSsrSafeAgents(): Promise<void> {
  const agents = [...cachedAgents.values()];
  cachedAgents.clear();
  await Promise.all(agents.map((agent) => agent.close()));
}

function createAgent(options: AgentCacheOptions): Agent {
  const connect =
    options.tlsMaxVersion === 'TLSv1.2'
      ? {
        lookup: createSsrSafeLookup({ lookup: options.lookup }),
        minVersion: 'TLSv1.2' as const,
        maxVersion: 'TLSv1.2' as const
      }
      : {
        lookup: createSsrSafeLookup({ lookup: options.lookup }),
        maxVersion: options.tlsMaxVersion
      };

  return new Agent({
    connect,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000
  });
}

export interface FeedFetchSource {
  id?: string;
  feedUrl: string;
  etag?: string | null;
  lastModified?: string | null;
  fetchOptions?: FetchOptions;
}

export type FetchImplementation = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

export interface FetchFeedOptions {
  maxBytes?: number;
  now?: () => string;
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
    permanentUrl?: string;
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
    permanentUrl?: string;
  };

const DEFAULT_TIMEOUT_MS = 15_000;

const DEFAULT_USER_AGENT = 'rss-discord-bridge/0.4.0';

const DEFAULT_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

const MAX_REDIRECTS = 3;

/** 기본 TLS와 필요 시 TLS 1.2 재시도를 조율하고 자동 호환 설정의 재검사 시점을 관리한다. */
export async function fetchFeed(source: FeedFetchSource, options: FetchFeedOptions = {}): Promise<FeedFetchResult> {
  const url = assertSafeFeedUrl(source.feedUrl);
  await verifyFeedUrlSafe(source.feedUrl, { lookup: options.lookup });

  const fetchOptions = source.fetchOptions ?? {};
  const now = options.now?.() ?? new Date().toISOString();
  // 자동 적용한 TLS 1.2만 하루 뒤 기본 TLS로 재검사한다. 관리자가 직접 지정한 TLS 옵션은 유지한다.
  const recheckTls = fetchOptions.tlsPinnedAt !== undefined && Date.parse(now) - Date.parse(fetchOptions.tlsPinnedAt) >= 86_400_000;
  const firstAttempt = await attemptFetch(source, recheckTls ? undefined : fetchOptions.tlsMaxVersion, options);
  if (firstAttempt.retryWithTls12) {
    const retryAttempt = await attemptFetch(source, 'TLSv1.2', options);
    if (retryAttempt.retryWithTls12) {
      throw new SecurityError('fetch_failed', 'TLSv1.2 retry requested another retry.');
    }
    const persistedFetchOptions = { ...fetchOptions, tlsMaxVersion: 'TLSv1.2' as const, tlsPinnedAt: now };
    if (source.id && options.persistFetchOptions) {
      await options.persistFetchOptions(source.id, persistedFetchOptions);
    }
    return {
      ...retryAttempt.result,
      url: url.toString(),
      usedTlsMaxVersion: 'TLSv1.2',
      persistedFetchOptions
    };
  }
  if (recheckTls) {
    const persistedFetchOptions = { ...fetchOptions };
    delete persistedFetchOptions.tlsMaxVersion;
    delete persistedFetchOptions.tlsPinnedAt;
    if (source.id && options.persistFetchOptions) await options.persistFetchOptions(source.id, persistedFetchOptions);
    return { ...firstAttempt.result, url: url.toString(), persistedFetchOptions };
  }
  return { ...firstAttempt.result, url: url.toString() };
}

/** 단일 TLS 프로필의 요청 전체에 타임아웃을 적용한다. 리다이렉트마다 URL과 DNS를 다시 검사한다. */
async function attemptFetch(
  source: FeedFetchSource,
  tlsMaxVersion: TlsMaxVersion | undefined,
  options: FetchFeedOptions
): Promise<{
  result: FeedFetchResult;
  retryWithTls12: false
} | {
  retryWithTls12: true
}> {
  const fetchImpl = options.fetchImpl ?? undiciFetch;
  const dispatcher = options.dispatcherFactory?.(tlsMaxVersion) ?? getSsrSafeAgent({ tlsMaxVersion, lookup: options.lookup });
  const timeoutMs = source.fetchOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? 5_242_880;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer.');
  const controller = new AbortController();
  // 리다이렉트마다 타이머를 새로 만들지 않아 여러 이동을 포함한 요청 전체에 같은 시간 예산을 적용한다.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const headers = buildHeaders(source);
  let currentUrl = source.feedUrl;
  let redirectCount = 0;
  let permanentRedirect = true;
  let response: Response | undefined;
  try {
    while (true) {
      response = await abortable(fetchImpl(currentUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        dispatcher,
        signal: controller.signal
      }), controller.signal);
      if (!isRedirect(response.status)) break;
      permanentRedirect = permanentRedirect && (response.status === 301 || response.status === 308);
      const location = header(response, 'location');
      await discardBody(response);
      if (!location)
        throw new SecurityError('http_error', 'Feed redirect did not include a location header.', { statusCode: response.status });
      if (redirectCount++ >= MAX_REDIRECTS)
        throw new SecurityError('redirect_blocked', 'Too many feed redirects.', { maxRedirects: MAX_REDIRECTS });
      const targetUrl = new URL(location, currentUrl).toString();
      // 처음 URL이 안전해도 리다이렉트가 내부 주소를 가리킬 수 있어 매번 재검증한다.
      assertSafeFeedUrl(targetUrl);
      await abortable(verifyFeedUrlSafe(targetUrl, { lookup: options.lookup }), controller.signal);
      currentUrl = targetUrl;
    }
    if (response.status === 304) {
      await discardBody(response);
      return {
        retryWithTls12: false, result: {
          kind: 'not-modified',
          statusCode: 304,
          url: source.feedUrl,
          etag: header(response, 'etag'),
          lastModified: header(response, 'last-modified'),
          usedTlsMaxVersion: tlsMaxVersion,
          permanentUrl: redirectCount > 0 && permanentRedirect ? currentUrl : undefined
        }
      };
    }
    if (response.status === 403 && !tlsMaxVersion) {
      await discardBody(response);
      return { retryWithTls12: true };
    }
    if (!response.ok) {
      await discardBody(response);
      throw new SecurityError('http_error', `Feed fetch failed with HTTP ${response.status}.`, { statusCode: response.status });
    }
    const bytes = await readBoundedBody(response, maxBytes, controller);
    const contentType = header(response, 'content-type');
    const charset = selectCharset(source.fetchOptions, contentType, bytes);
    return {
      retryWithTls12: false, result: {
        kind: 'ok',
        statusCode: response.status,
        url: source.feedUrl,
        body: decodeBytes(bytes, charset),
        etag: header(response, 'etag'),
        lastModified: header(response, 'last-modified'),
        contentType,
        charset,
        usedTlsMaxVersion: tlsMaxVersion,
        permanentUrl: redirectCount > 0 && permanentRedirect ? currentUrl : undefined
      }
    };
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    if (!tlsMaxVersion && !controller.signal.aborted && isTlsHandshakeError(error)) return { retryWithTls12: true };
    if (controller.signal.aborted) throw new SecurityError('timeout', 'Feed fetch timed out.');
    throw mapFetchError(error);
  } finally {
    clearTimeout(timer);
    if (response && !response.bodyUsed) await discardBody(response);
  }
}

/** 헤더의 크기 정보와 실제 스트림 누적량을 모두 검사하고 초과 시 수신을 중단한다. */
async function readBoundedBody(response: Response, maxBytes: number, controller: AbortController): Promise<Uint8Array> {
  // Content-Length가 없거나 잘못되어도 실제 수신량을 별도로 제한한다.
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > maxBytes) {
    controller.abort();
    throw new SecurityError('response_too_large', 'Feed response exceeds the byte limit.', { maxBytes });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), controller.signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        controller.abort();
        throw new SecurityError('response_too_large', 'Feed response exceeds the byte limit.', { maxBytes });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 취소를 지원하지 않는 Promise도 AbortSignal과 함께 기다릴 수 있게 하고 리스너를 정리한다. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SecurityError('timeout', 'Feed fetch timed out.'));
    if (signal.aborted) {
      void operation.catch(() => undefined);
      reject(new SecurityError('timeout', 'Feed fetch timed out.'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** 소스별 헤더를 적용한 뒤 저장된 ETag·Last-Modified로 조건부 GET을 구성한다. */
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

/** 수동 지정 → HTTP Content-Type → XML 선언 → UTF-8 순서로 디코딩 문자셋을 고른다. */
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

/** 같은 인코딩의 관용 표기를 TextDecoder가 해석할 이름으로 맞춘다. */
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

/** 본문을 쓰지 않는 응답도 취소해 연결 자원을 반환한다. 정리 실패가 원래 오류를 덮지는 않는다. */
async function discardBody(response: Response): Promise<void> {
  if (!response.body || response.bodyUsed) return;
  try {
    await response.body.cancel();
  } catch {
    // 연결 정리 실패가 수집 결과나 원래 오류를 덮어쓰지 않게 한다.
  }
}

function header(response: Response, name: string): string | null {
  return response.headers.get(name);
}

function isRedirect(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

/** 중첩 원인에서 프로토콜 호환 오류를 찾는다. 인증서 오류는 TLS 호환 재시도로 우회하지 않는다. */
function isTlsHandshakeError(error: unknown): boolean {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    messages.push(current instanceof Error ? current.message : String(current));
    if (typeof current !== 'object') break;
    if ('code' in current) messages.push(String(current.code));
    current = 'cause' in current ? current.cause : undefined;
  }
  const message = messages.join(' ');
  if (/certificate|cert_|self.signed|unable.to.verify/i.test(message)) return false;
  return /tls|ssl|handshake|wrong.version|protocol.version/i.test(message);
}

/** 하위 네트워크 예외를 수집 계층에서 처리할 공통 오류 코드로 정리한다. */
function mapFetchError(error: unknown): SecurityError {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout/i.test(message)) {
    return new SecurityError('timeout', 'Feed fetch timed out.');
  }
  return new SecurityError('fetch_failed', 'Feed fetch failed.', { message });
}

export const TLS_MAX_VERSIONS = ['TLSv1.2', 'TLSv1.3'] as const;

export type TlsMaxVersion = (typeof TLS_MAX_VERSIONS)[number];

export interface FetchOptions {
  charset?: string;
  userAgent?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  tlsMaxVersion?: TlsMaxVersion;
  /** 자동 TLS 호환 모드 적용 시각. 수동 TLS 설정에는 없으며 기본 TLS 재검사 여부를 판단한다. */
  tlsPinnedAt?: string;
}
