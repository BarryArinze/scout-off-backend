import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  listWebhookDeadLetters,
  countWebhookDeadLetters,
  getWebhookDeadLetterById,
  listWebhookSubscriptions,
  markWebhookDeadLetterReplayed,
  updateWebhookDeadLetterAttempt,
} from '../db';
import { postWebhookWithRetry } from '../services/webhooks';
import { logger } from '../utils/logger';

/** Exported so routes can apply validateQuery(listDeadLettersQuerySchema) */
export const listDeadLettersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /api/admin/webhooks/dead-letters */
export async function listDeadLetters(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = listDeadLettersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
      });
      return;
    }
    const { page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;

    const rows = listWebhookDeadLetters(pageSize, offset);
    const total = countWebhookDeadLetters();

    const data = rows.map((row) => ({
      id: row.id,
      subscriptionId: row.subscription_id,
      url: row.url,
      eventType: row.event_type,
      payload: JSON.parse(row.payload),
      failureReason: row.failure_reason,
      attempts: row.attempts,
      status: row.status,
      createdAt: row.created_at,
      replayedAt: row.replayed_at,
    }));

    res.json({ success: true, data, total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

const replayParamsSchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
});

/**
 * POST /api/admin/webhooks/:id/replay
 *
 * Re-attempts delivery of a single dead-lettered webhook. Re-signs the
 * original payload with the subscription's *current* secret (it may have
 * rotated since the original attempt) and re-runs the standard retry/backoff
 * flow via postWebhookWithRetry. On success the row is marked `replayed`; on
 * failure the attempt count/reason are updated and the row stays `pending` —
 * either way this endpoint responds with a clear result rather than
 * propagating an unhandled error.
 */
export async function replayDeadLetter(req: Request, res: Response, next: NextFunction) {
  try {
    const parsedParams = replayParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        success: false,
        error: parsedParams.error.errors[0]?.message ?? 'Invalid id',
      });
      return;
    }
    const { id } = parsedParams.data;

    const deadLetter = getWebhookDeadLetterById(id);
    if (!deadLetter) {
      res.status(404).json({ success: false, error: 'Dead-lettered delivery not found' });
      return;
    }
    if (deadLetter.status === 'replayed') {
      res.status(409).json({ success: false, error: 'Delivery has already been replayed' });
      return;
    }

    const subscriptions = listWebhookSubscriptions();
    const subscription =
      subscriptions.find((s) => s.id === deadLetter.subscription_id) ??
      subscriptions.find((s) => s.url === deadLetter.url);

    try {
      await postWebhookWithRetry(deadLetter.url, JSON.parse(deadLetter.payload), {
        retries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        secret: subscription?.secret,
      });

      markWebhookDeadLetterReplayed(id);
      res.json({
        success: true,
        message: 'Webhook delivery replayed successfully',
        data: { id, status: 'replayed' },
      });
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      const attempts = deadLetter.attempts + 3;
      updateWebhookDeadLetterAttempt(id, attempts, failureReason);
      logger.warn(`[webhooks] replay failed — id=${id} url=${deadLetter.url} reason=${failureReason}`);
      res.status(502).json({
        success: false,
        message: 'Replay attempt failed; delivery remains dead-lettered',
        error: failureReason,
        data: { id, status: 'pending', attempts },
      });
    }
  } catch (err) {
    next(err);
  }
}
