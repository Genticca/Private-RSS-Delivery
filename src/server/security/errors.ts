export type SecurityErrorCode =
  | 'invalid_url'
  | 'ssrf_blocked'
  | 'redirect_blocked'
  | 'http_error'
  | 'timeout'
  | 'fetch_failed'
  | 'unsupported_charset'
  | 'webhook_not_allowed';

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
