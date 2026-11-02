export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 429);
  }
}

/** Structured trading errors — message prefix is the machine code */
export class TradingError extends AppError {
  readonly code: string;
  constructor(code: string, message: string, statusCode = 400) {
    super(`${code}: ${message}`, statusCode);
    this.code = code;
  }
}

export function tradingPausedError(): TradingError {
  return new TradingError('TRADING_PAUSED', 'Trading is temporarily paused', 503);
}

export function priceStaleError(ageMs: number): TradingError {
  return new TradingError('PRICE_STALE', `Mark price is stale (age ${ageMs}ms)`, 503);
}

export function noRouteError(detail?: string): TradingError {
  return new TradingError('NO_ROUTE', detail || 'No executable swap route', 400);
}

export function insufficientMarginError(): TradingError {
  return new TradingError('INSUFFICIENT_MARGIN', 'Insufficient available margin', 400);
}

export function slippageError(detail?: string): TradingError {
  return new TradingError('SLIPPAGE', detail || 'Quote exceeds max slippage', 400);
}

/**
 * Marker for failures that occur strictly before any network send / broadcast.
 * Safe to clear signingStartedAt and unlock funds — nothing was submitted on-chain.
 */
export class PreSendError extends AppError {
  readonly preSend = true as const;
  constructor(message: string, status = 400) {
    super(message, status);
  }
}
