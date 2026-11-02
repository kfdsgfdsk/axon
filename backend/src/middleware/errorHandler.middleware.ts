import { Request, Response, NextFunction } from 'express';
import { AppError, ValidationError } from '../utils/errors';
import logger from '../utils/logger';
import config from '../config';

/**
 * Map body-parser failures to operational statuses (S-M9): malformed JSON →
 * 400, oversized → 413. Without this they fall through to the 500 handler.
 * Exported for unit tests; mounted in app.ts right after the body parsers.
 */
export const bodyParserErrorHandler = (
  err: { type?: string; status?: number; statusCode?: number; message?: string },
  _req: Request,
  _res: Response,
  next: NextFunction
) => {
  if (err?.type === 'entity.too.large') {
    return next(new AppError('Request body too large', 413));
  }
  if (
    err?.type === 'entity.parse.failed' ||
    (err instanceof SyntaxError && 'body' in (err as object))
  ) {
    return next(new ValidationError('Malformed JSON body'));
  }
  next(err);
};

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (err instanceof AppError) {
    // Auth 401s: path + reason only (never token string)
    if (err.statusCode === 401) {
      logger.warn('Auth 401', {
        path: req.originalUrl,
        method: req.method,
        reason: err.message,
      });
    } else {
      logger.warn(`${err.statusCode} - ${err.message}`, {
        path: req.originalUrl,
        method: req.method,
      });
    }

    const body: Record<string, unknown> = {
      success: false,
      message: err.message,
    };
    if ('code' in err && (err as any).code) {
      body.code = (err as any).code;
    }
    return res.status(err.statusCode).json(body);
  }

  // Unexpected errors
  logger.error(`Unexpected error: ${err.message}`, { stack: err.stack, path: req.originalUrl });

  // Gate on isProdLike (S-M9): staging must not leak engine internals either.
  return res.status(500).json({
    success: false,
    message: config.isProdLike ? 'Internal server error' : err.message,
  });
};
