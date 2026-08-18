import { Request, Response, NextFunction } from 'express';
import { getIdempotencyRecord, saveIdempotencyRecord } from '../db';
import { logger } from '../utils/logger';

/**
 * Idempotency middleware for mutating endpoints.
 *
 * Behaviour:
 *  - If no `Idempotency-Key` header is present, the request is passed through unchanged.
 *  - If the key is present and an unexpired record exists, the cached status code and
 *    body are returned immediately without executing the downstream handler.
 *  - If the key is present but no record exists, the request is processed normally.
 *    After the handler writes its response the middleware intercepts `res.json()` to
 *    persist the key + response so subsequent retries are served from cache.
 *
 * Keys expire after 24 hours (controlled by IDEMPOTENCY_TTL_MS in db/index.ts).
 */
export async function idempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.headers['idempotency-key'];

  // No key supplied — pass through without any idempotency behaviour.
  if (!key || typeof key !== 'string' || key.trim() === '') {
    next();
    return;
  }

  const trimmedKey = key.trim();

  // Check for a cached response.
  try {
    const record = await getIdempotencyRecord(trimmedKey);
    if (record) {
      logger.info(`[idempotency] cache_hit key=${trimmedKey}`);
      res.status(record.status_code).json(JSON.parse(record.response));
      return;
    }
  } catch (err) {
    // DB read failure is non-fatal; fall through and process normally.
    logger.warn(`[idempotency] cache_lookup_error key=${trimmedKey} err=${(err as Error).message}`);
    next();
    return;
  }

  // No cached response — intercept res.json so we can capture the response.
  const originalJson = res.json.bind(res);

  res.json = function (body: unknown): Response {
    // Persist the response before sending; ignore errors (best-effort). This
    // stays fire-and-forget rather than awaited: res.json must return
    // synchronously to preserve Express's response contract.
    saveIdempotencyRecord(trimmedKey, res.statusCode, body)
      .then(() => logger.info(`[idempotency] cache_stored key=${trimmedKey} status=${res.statusCode}`))
      .catch((err: unknown) =>
        logger.warn(`[idempotency] cache_store_error key=${trimmedKey} err=${(err as Error).message}`),
      );
    return originalJson(body);
  };

  next();
}
