export type ErrorCode = 'INVALID_INPUT' | 'AUTH_REQUIRED' | 'AUTH_REJECTED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'INVALID_RESPONSE' | 'NETWORK_ERROR' | 'CANCELLED' | 'QUEUE_FULL';

export class Park4nightError extends Error {
  readonly code: ErrorCode;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: ErrorCode, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'Park4nightError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function cancelled(): Park4nightError {
  return new Park4nightError('CANCELLED', 'The request was cancelled. A sent write may already have taken effect.');
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

export function errorResult(error: unknown): { error: string; message: string; retryAfterMs?: number } {
  return error instanceof Park4nightError
    ? { error: error.code, message: error.message, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) }
    : { error: 'CLIENT_ERROR', message: 'The operation failed. Check input and credential access.' };
}
