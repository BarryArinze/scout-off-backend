import fetch from 'node-fetch';
import crypto from 'crypto';
import {
  listWebhookSubscriptions,
  insertWebhookDeadLetter,
  WebhookSubscription,
} from '../db';
import { logger } from '../utils/logger';
import { recordWebhookDelivery } from '../middleware/metrics';

type WebhookRetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** When provided, the raw JSON body is signed with HMAC-SHA256 using this secret. */
  secret?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Computes the `X-Webhook-Signature` header value for a raw request body.
 *
 * Format: `sha256=<hex-encoded HMAC-SHA256 digest>`, computed over the exact
 * raw bytes sent on the wire (not a re-serialized object) using the
 * subscriber's secret as the HMAC key. See docs/webhooks.md for the
 * receiver-side verification procedure.
 */
export function signWebhookPayload(rawBody: string, secret: string): string {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

/**
 * Executes a webhook POST with retry logic.
 * Uses exponential backoff between attempts to reduce pressure on transient failures.
 * When `options.secret` is provided, signs the raw request body and attaches it as
 * the `X-Webhook-Signature` header.
 */
export async function postWebhookWithRetry(
  url: string,
  payload: unknown,
  options: WebhookRetryOptions = {}
): Promise<void> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  let lastError: unknown;

  // Serialize once so the signature is computed over the exact bytes sent.
  const rawBody = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.secret) {
    headers['X-Webhook-Signature'] = signWebhookPayload(rawBody, options.secret);
  }

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: rawBody,
        headers,
      });

      if (!response.ok) {
        throw new Error(`Webhook dispatch failed with status ${response.status}`);
      }
      return;
    } catch (err) {
      lastError = err;
    }

    if (attempt < retries) {
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

const RETRY_OPTIONS = { retries: 3, baseDelayMs: 500, maxDelayMs: 5000 };

/**
 * Dispatches an event to every registered webhook subscriber, signing each
 * delivery with that subscriber's own secret. If a delivery exhausts its
 * retries, it is persisted to the dead-letter queue (webhook_dead_letters)
 * instead of being dropped — this function itself never rejects on a
 * delivery failure so a slow/broken subscriber can't break the caller.
 */
export async function dispatchEventWebhook(eventType: string, payload: unknown): Promise<void> {
  const subscriptions = listWebhookSubscriptions();
  if (subscriptions.length === 0) return;

  const body = { eventType, payload };

  await Promise.all(
    subscriptions.map((subscription: WebhookSubscription) =>
      deliverToSubscription(subscription, eventType, body)
    )
  );
}

async function deliverToSubscription(
  subscription: WebhookSubscription,
  eventType: string,
  body: unknown
): Promise<void> {
  try {
    await postWebhookWithRetry(subscription.url, body, {
      ...RETRY_OPTIONS,
      secret: subscription.secret,
    });
    recordWebhookDelivery('success');
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[webhooks] delivery exhausted retries — subscriptionId=${subscription.id} url=${subscription.url} eventType=${eventType} reason=${failureReason}`
    );
    insertWebhookDeadLetter({
      subscriptionId: subscription.id,
      url: subscription.url,
      eventType,
      payload: JSON.stringify(body),
      failureReason,
      attempts: RETRY_OPTIONS.retries,
    });
    recordWebhookDelivery('dead_letter');
  }
}
