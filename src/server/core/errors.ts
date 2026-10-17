

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

export type AppErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'conflict'
  | 'ssrf_blocked'
  | 'webhook_not_allowed'
  | 'rate_limited'
  | 'internal_error';

/** 관리 요청에 표시할 예상 가능한 오류다. HTTP 상태·오류 코드·필드별 안내를 함께 전달한다. */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: AppErrorCode,
    message: string,
    readonly fields?: Record<string, string>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function validationError(message: string, fields?: Record<string, string>): AppError {
  return new AppError(400, 'validation_error', message, fields);
}

export function notFound(message: string): AppError {
  return new AppError(404, 'not_found', message);
}

export function conflict(message: string, fields?: Record<string, string>): AppError {
  return new AppError(409, 'conflict', message, fields);
}
