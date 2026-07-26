/**
 * Background retry job for the webhook dead-letter queue.
 *
 * Every 5 minutes the job:
 *   1. Checks whether the dead-letter count exceeds OVERFLOW_THRESHOLD and
 *      emits an error-level log event when it does.
 *   2. Picks up pending rows older than 10 minutes whose retry_count < 5.
 *   3. Re-attempts delivery via postWebhookWithRetry.
 *   4. On success: deletes the dead-letter row and increments
 *      webhook_retry_success_total.
 *   5. On failure: increments retry_count / last_attempted_at and leaves the
 *      row in the queue.
 */

import {
  countWebhookDeadLetters,
  listWebhookDeadLetters,
  listWebhookSubscriptions,
  getWebhookDeadLetterById,
  markWebhookDeadLetterReplayed,
  updateWebhookDeadLetterAttempt,
  WebhookDeadLetter,
} from '../db';
import { postWebhookWithRetry } from './webhooks';
import { logger } from '../utils/logger';
import { incrementWebhookRetrySuccessTotal } from '../middleware/metrics';

// ─── Configuration ─────────────────────────────────────────────────────────────

/** How often the retry job runs (ms). */
export const DEAD_LETTER_JOB_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/** Dead letters must be at least this old before auto-retry (ms). */
const MIN_AGE_BEFORE_RETRY_MS = 10 * 60 * 1000; // 10 min

/** Maximum number of auto-retries per dead-letter row. */
export const MAX_AUTO_RETRIES = 5;

/** Queue depth that triggers the overflow alert. */
const OVERFLOW_THRESHOLD = 100;

// ─── Core logic (exported for testing) ────────────────────────────────────────

/**
 * Run one iteration of the dead-letter retry sweep.
 * Returns the number of rows successfully re-delivered.
 */
export async function runDeadLetterRetryJob(): Promise<number> {
  let successCount = 0;

  // ── Overflow alerting ────────────────────────────────────────────────────────
  const total = countWebhookDeadLetters();
  if (total > OVERFLOW_THRESHOLD) {
    logger.error(
      `[webhooks] webhook_dead_letter_overflow — queue depth ${total} exceeds threshold ${OVERFLOW_THRESHOLD}`,
    );
  }

  // ── Pick eligible rows ───────────────────────────────────────────────────────
  // Fetch a generous page (up to 200) and filter in-process so we don't need
  // a custom SQL query.  The queue is expected to stay small; if it grows very
  // large the overflow alert above fires long before we'd need batching here.
  const rows = listWebhookDeadLetters(200, 0);
  const cutoff = new Date(Date.now() - MIN_AGE_BEFORE_RETRY_MS).toISOString();

  const eligible = rows.filter(
    (r: WebhookDeadLetter) =>
      r.status === 'pending' &&
      r.attempts < MAX_AUTO_RETRIES &&
      r.created_at <= cutoff,
  );

  if (eligible.length === 0) return 0;

  const subscriptions = listWebhookSubscriptions();

  await Promise.all(
    eligible.map(async (deadLetter: WebhookDeadLetter) => {
      // Re-fetch to guard against a concurrent replay already marking it done.
      const current = getWebhookDeadLetterById(deadLetter.id);
      if (!current || current.status === 'replayed') return;

      const subscription =
        subscriptions.find((s) => s.id === current.subscription_id) ??
        subscriptions.find((s) => s.url === current.url);

      try {
        await postWebhookWithRetry(current.url, JSON.parse(current.payload), {
          retries: 2,
          baseDelayMs: 500,
          maxDelayMs: 5000,
          secret: subscription?.secret,
        });

        markWebhookDeadLetterReplayed(current.id);
        incrementWebhookRetrySuccessTotal();
        successCount += 1;

        logger.info(
          `[webhooks] dead-letter auto-retry succeeded — id=${current.id} url=${current.url}`,
        );
      } catch (err) {
        const failureReason = err instanceof Error ? err.message : String(err);
        const newAttempts = current.attempts + 1;
        updateWebhookDeadLetterAttempt(current.id, newAttempts, failureReason);

        logger.warn(
          `[webhooks] dead-letter auto-retry failed — id=${current.id} url=${current.url} ` +
            `attempts=${newAttempts} reason=${failureReason}`,
        );
      }
    }),
  );

  return successCount;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let _jobInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background dead-letter retry job.
 * Safe to call multiple times — subsequent calls are no-ops if the job is
 * already running.
 */
export function startDeadLetterRetryJob(): void {
  if (_jobInterval !== null) return;

  _jobInterval = setInterval(async () => {
    try {
      const n = await runDeadLetterRetryJob();
      if (n > 0) {
        logger.info(`[webhooks] dead-letter job completed — ${n} deliveries retried successfully`);
      }
    } catch (err) {
      logger.error('[webhooks] dead-letter job error:', err);
    }
  }, DEAD_LETTER_JOB_INTERVAL_MS);

  // Don't prevent graceful shutdown.
  if (_jobInterval.unref) _jobInterval.unref();

  logger.info('[webhooks] dead-letter retry job started');
}

/**
 * Stop the background job.  Intended for graceful shutdown and test isolation.
 */
export function stopDeadLetterRetryJob(): void {
  if (_jobInterval !== null) {
    clearInterval(_jobInterval);
    _jobInterval = null;
  }
}

/**
 * Expose internal state for testing.
 */
export function isDeadLetterJobRunning(): boolean {
  return _jobInterval !== null;
}
