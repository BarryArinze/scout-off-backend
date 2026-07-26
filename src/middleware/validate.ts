import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';

interface ValidationOptions {
  context?: string;
}

function getCorrelationId(req: Request): string {
  return String(req.headers?.['x-correlation-id'] ?? req.headers?.['correlation-id'] ?? 'none');
}

/**
 * Middleware factory that validates `req.body` against a Zod schema.
 *
 * On validation failure: returns HTTP 400 with `{ success: false, error: 'Validation Error', details: [{ field, message }] }`.
 * On success: sets `req.body` to the parsed/coerced value and calls `next()`.
 *
 * Usage: router.post('/route', validateBody(mySchema), handler)
 */
export function validateBody<T>(schema: ZodSchema<T>, options?: ValidationOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const correlationId = getCorrelationId(req);
      const details = result.error.errors.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      }));
      logger.warn(
        `[validation] ${options?.context ?? 'body'} rejected — error=${
          result.error.errors[0]?.message ?? 'Invalid request body'
        } correlationId=${correlationId}`
      );
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        details,
        code: ErrorCode.VALIDATION_ERROR,
        correlationId,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Middleware factory that validates `req.query` against a Zod schema.
 *
 * On validation failure: returns HTTP 400 with `{ success: false, error: 'Validation Error', details: [{ field, message }] }`.
 * On success: stores the parsed/coerced result in `req.query` and calls `next()`.
 *
 * Usage: router.get('/route', validateQuery(mySchema), handler)
 */
export function validateQuery<T>(schema: ZodSchema<T>, options?: ValidationOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const correlationId = getCorrelationId(req);
      const details = result.error.errors.map((err) => ({
        field: err.path.join('.'),
        message: err.message,
      }));
      logger.warn(
        `[validation] ${options?.context ?? 'query'} rejected — error=${
          result.error.errors[0]?.message ?? 'Invalid query parameters'
        } correlationId=${correlationId}`
      );
      res.status(400).json({
        success: false,
        error: 'Validation Error',
        details,
        code: ErrorCode.VALIDATION_ERROR,
        correlationId,
      });
      return;
    }
    // Cast so the controller can read coerced + defaulted values via req.query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).query = result.data;
    next();
  };
}
