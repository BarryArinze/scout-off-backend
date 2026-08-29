import fetch from 'node-fetch';
import config from '../config';
import { insertWebhookDelivery } from '../db';
import { logger } from '../utils/logger';

type WebhookRetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a simple unique delivery ID (timestamp + random hex). */
function newDeliveryId(): string {
  return `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Executes a webhook POST with retry logic.
 * Uses exponential backoff between attempts to reduce pressure on transient failures.
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

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
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

export interface DispatchOptions {
  subscriptionId?: string;
  eventType?: string;
}

/**
 * Deliver a single webhook call and persist a delivery-attempt record.
 * Succeeds or throws; the caller decides whether to dead-letter.
 *
 * @param url          - The endpoint to POST to
 * @param eventType    - The event type label (e.g. 'player_registered')
 * @param payload      - The event payload
 * @param subscriptionId - Subscription identifier (defaults to URL)
 * @param retryOptions - Retry configuration
 */
export async function deliverToSubscription(
  url: string,
  eventType: string,
  payload: unknown,
  subscriptionId?: string,
  retryOptions: WebhookRetryOptions = {},
): Promise<void> {
  const deliveryId = newDeliveryId();
  const subId = subscriptionId ?? url;
  const retries = retryOptions.retries ?? 3;
  const start = Date.now();
  let attemptCount = 0;
  let lastError: unknown;

  const baseDelayMs = retryOptions.baseDelayMs ?? 500;
  const maxDelayMs = retryOptions.maxDelayMs ?? 5000;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    attemptCount = attempt;
    let statusCode: number | null = null;

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ eventType, payload }),
        headers: { 'Content-Type': 'application/json' },
      });
      statusCode = response.status;

      if (!response.ok) {
        throw new Error(`Webhook dispatch failed with status ${response.status}`);
      }

      // Success — record and return
      try {
        insertWebhookDelivery({
          subscriptionId: subId,
          eventType,
          deliveryId,
          attemptCount,
          status: 'success',
          statusCode,
          latencyMs: Date.now() - start,
        });
      } catch (dbErr) {
        logger.warn({ dbErr }, '[webhooks] failed to persist delivery record');
      }
      return;
    } catch (err) {
      lastError = err;
      const errMessage = err instanceof Error ? err.message : String(err);

      if (attempt === retries) {
        // Final attempt — record failure
        try {
          insertWebhookDelivery({
            subscriptionId: subId,
            eventType,
            deliveryId,
            attemptCount,
            status: 'failure',
            statusCode,
            errorMessage: errMessage,
            latencyMs: Date.now() - start,
          });
        } catch (dbErr) {
          logger.warn({ dbErr }, '[webhooks] failed to persist delivery record');
        }
      }
    }

    if (attempt < retries) {
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export async function dispatchEventWebhook(eventType: string, payload: unknown): Promise<void> {
  if (!config.webhook.enabled || !config.webhook.url) {
    return;
  }
  await deliverToSubscription(config.webhook.url, eventType, payload, config.webhook.url, {
    retries: 3,
    baseDelayMs: 500,
    maxDelayMs: 5000,
  });
}
