// 피드와 웹훅의 외부 통신은 이 경로의 URL·DNS 검증과 안전한 연결 풀을 사용한다.
export { getSsrSafeAgent, closeSsrSafeAgents } from './agent-cache.js';
export { SecurityError, type SecurityErrorCode } from './errors.js';
export {
  assertAddressAllowed,
  assertSafeFeedUrl,
  createSsrSafeLookup,
  parseHttpUrl,
  resolveSafeHostname,
  verifyFeedUrlSafe,
  type DnsLookup,
  type LookupAddress,
  type SsrSafeLookup
} from './ip.js';
export {
  fetchFeed,
  type FeedFetchResult,
  type FeedFetchSource,
  type FetchFeedOptions,
  type FetchImplementation
} from './ssrf-fetch.js';
export { TLS_MAX_VERSIONS, type FetchOptions, type TlsMaxVersion } from './types.js';
export { assertSafeWebhookMessageUrl, assertSafeWebhookUrl, canonicalWebhookUrl, verifyWebhookUrlSafe } from './webhook-guard.js';
