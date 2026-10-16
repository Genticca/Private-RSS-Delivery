export const TLS_MAX_VERSIONS = ['TLSv1.2', 'TLSv1.3'] as const;

export type TlsMaxVersion = (typeof TLS_MAX_VERSIONS)[number];

export interface FetchOptions {
  charset?: string;
  userAgent?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  tlsMaxVersion?: TlsMaxVersion;
  /** Internal timestamp for automatic compatibility fallback; absent on manual TLS settings. */
  tlsPinnedAt?: string;
}
