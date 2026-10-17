export type SecurityErrorCode =
  | 'invalid_url'
  | 'ssrf_blocked'
  | 'redirect_blocked'
  | 'http_error'
  | 'timeout'
  | 'fetch_failed'
  | 'response_too_large'
  | 'unsupported_charset'
  | 'webhook_not_allowed';

/** 외부 요청의 보안 검사·통신 실패를 구분한다. details는 상태 코드 등 진단 정보를 담는다. */
export class SecurityError extends Error {
  constructor(
    readonly code: SecurityErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'SecurityError';
  }
}
