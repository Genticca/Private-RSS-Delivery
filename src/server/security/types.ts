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
