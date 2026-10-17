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
