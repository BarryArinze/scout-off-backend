import { Request, RequestHandler } from 'express';
import { ZodSchema } from 'zod';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import { sanitizeObject } from '../utils/sanitizer';

interface ValidationOptions {
  context?: string;
}

function getCorrelationId(req: Request): string {
  return String(req.headers?.['x-correlation-id'] ?? req.headers?.['correlation-id'] ?? 'none');
}

/**
 * express.json() silently skips parsing (leaving req.body empty) when Content-Type
 * doesn't match 'application/json' rather than erroring, so this must be checked
 * explicitly — otherwise a missing/incorrect Content-Type surfaces as a confusing
 * "required" Zod error instead of a clear 415.
 */
function hasJsonContentType(req: Request): boolean {
  const contentType = req.headers?.['content-type'];
  if (!contentType) return false;
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * True when the request actually carries a body (non-zero Content-Length, or
 * chunked transfer-encoding). Some JSON-validated routes accept a body-less
 * request (e.g. an all-optional or empty schema) — those should keep working
 * without a Content-Type header, so the 415 check only applies once the client
 * has actually sent bytes that need a Content-Type to be interpreted correctly.
 */
function hasRequestBody(req: Request): boolean {
  const contentLength = req.headers?.['content-length'];
  if (contentLength && parseInt(contentLength, 10) > 0) return true;
  const transferEncoding = req.headers?.['transfer-encoding'];
  return typeof transferEncoding === 'string' && transferEncoding.toLowerCase().includes('chunked');
}

/**
 * Middleware factory that validates `req.body` against a Zod schema.
 *
 * Returns HTTP 415 if the request carries a body but its Content-Type is missing
 * or isn't `application/json`.
 * On validation failure: returns HTTP 400 with `{ success: false, error: '<message>' }`.
 * On success: sets `req.body` to the parsed/coerced value and calls `next()`.
 *
 * Usage: router.post('/route', validateBody(mySchema), handler)
 */
export function validateBody<T>(schema: ZodSchema<T>, options?: ValidationOptions): RequestHandler {
  return (req, res, next): void => {
    if (hasRequestBody(req) && !hasJsonContentType(req)) {
      const correlationId = getCorrelationId(req);
      logger.warn(
        `[validation] ${options?.context ?? 'body'} rejected — missing or invalid Content-Type correlationId=${correlationId}`
      );
      res.status(415).json({
        success: false,
        error: 'Content-Type must be application/json',
        code: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
        correlationId,
      });
      return;
    }
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
    req.body = sanitizeObject(result.data);
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
export function validateQuery<T>(schema: ZodSchema<T>, options?: ValidationOptions): RequestHandler {
  return (req, res, next): void => {
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
    (req as any).query = sanitizeObject(result.data);
    next();
  };
}

/**
 * Middleware factory that validates `req.params` against a Zod schema.
 *
 * On validation failure: returns HTTP 400 with `{ success: false, error: '<message>' }`.
 * On success: merges validated params back into `req.params` and calls `next()`.
 *
 * Usage: router.get('/route/:id', validateParams(mySchema), handler)
 */
export function validateParams<T>(schema: ZodSchema<T>, options?: ValidationOptions): RequestHandler {
  return (req, res, next): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      const correlationId = getCorrelationId(req);
      logger.warn(
        `[validation] ${options?.context ?? 'params'} rejected — error=${
          result.error.errors[0]?.message ?? 'Invalid route parameters'
        } correlationId=${correlationId}`
      );
      res.status(400).json({
        success: false,
        error: result.error.errors[0]?.message ?? 'Invalid route parameters',
      });
      return;
    }
    req.params = { ...req.params, ...(sanitizeObject(result.data) as Record<string, string>) };
    next();
  };
}
