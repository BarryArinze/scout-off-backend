import fetch from 'node-fetch';
import crypto from 'crypto';
import { postWebhookWithRetry, signWebhookPayload, dispatchEventWebhook } from '../../src/services/webhooks';
import { createWebhookSubscription, listWebhookDeadLetters } from '../../src/db';

jest.mock('node-fetch', () => jest.fn());

const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

function uniqueUrl(label: string): string {
  return `https://example.com/hook-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe('postWebhookWithRetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns successfully when the first request succeeds', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);

    await expect(postWebhookWithRetry('https://example.com', { eventType: 'test' })).resolves.toBeUndefined();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on an initial failure and succeeds on a later attempt', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('network fail'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);

    await expect(
      postWebhookWithRetry('https://example.com', { eventType: 'test' }, { retries: 3, baseDelayMs: 1, maxDelayMs: 2 })
    ).resolves.toBeUndefined();

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after all retries fail', async () => {
    mockedFetch.mockRejectedValue(new Error('network down'));

    await expect(
      postWebhookWithRetry('https://example.com', { eventType: 'test' }, { retries: 2, baseDelayMs: 1, maxDelayMs: 2 })
    ).rejects.toThrow('network down');

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('signs the raw request body and attaches X-Webhook-Signature when a secret is provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);
    const payload = { eventType: 'test', payload: { a: 1 } };

    await postWebhookWithRetry('https://example.com', payload, { secret: 'shh-secret' });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockedFetch.mock.calls[0];
    const rawBody = init!.body as string;
    expect(rawBody).toBe(JSON.stringify(payload));

    const signatureHeader = (init!.headers as Record<string, string>)['X-Webhook-Signature'];
    expect(signatureHeader).toMatch(/^sha256=[0-9a-f]{64}$/);

    const expectedDigest = crypto.createHmac('sha256', 'shh-secret').update(rawBody).digest('hex');
    expect(signatureHeader).toBe(`sha256=${expectedDigest}`);
  });

  it('omits the signature header when no secret is provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);

    await postWebhookWithRetry('https://example.com', { eventType: 'test' });

    const [, init] = mockedFetch.mock.calls[0];
    expect((init!.headers as Record<string, string>)['X-Webhook-Signature']).toBeUndefined();
  });
});

describe('signWebhookPayload', () => {
  it('produces the documented sha256=<hex> format, verifiable by recomputing the HMAC with the same secret', () => {
    const secret = 'my-subscriber-secret';
    const rawBody = JSON.stringify({ eventType: 'player_registered', payload: { wallet: 'GABC' } });

    const signature = signWebhookPayload(rawBody, secret);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);

    // A receiver recomputing the HMAC over the same raw body with the same
    // secret must derive the identical signature (docs/webhooks.md).
    const recomputed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    expect(signature).toBe(`sha256=${recomputed}`);
  });

  it('produces a different signature for a different secret or a different body', () => {
    const rawBody = JSON.stringify({ eventType: 'test' });
    expect(signWebhookPayload(rawBody, 'secret-a')).not.toBe(signWebhookPayload(rawBody, 'secret-b'));

    const otherBody = JSON.stringify({ eventType: 'other' });
    expect(signWebhookPayload(rawBody, 'secret-a')).not.toBe(signWebhookPayload(otherBody, 'secret-a'));
  });
});

describe('dispatchEventWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delivers to a registered subscription signed with its own secret', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedFetch.mockResolvedValue({ ok: true, status: 200 } as any);
    const url = uniqueUrl('delivered');
    const secret = 'subscriber-secret-a';
    createWebhookSubscription(url, secret);

    await dispatchEventWebhook('player_registered', { wallet: 'GABC' });

    const call = mockedFetch.mock.calls.find(([calledUrl]) => calledUrl === url);
    expect(call).toBeDefined();
    const [, init] = call!;
    const rawBody = init!.body as string;
    const signatureHeader = (init!.headers as Record<string, string>)['X-Webhook-Signature'];
    expect(signatureHeader).toBe(signWebhookPayload(rawBody, secret));
    expect(JSON.parse(rawBody)).toEqual({ eventType: 'player_registered', payload: { wallet: 'GABC' } });
  });

  it(
    'persists a dead letter with the right fields when retries are exhausted, without throwing',
    async () => {
      mockedFetch.mockRejectedValue(new Error('connection refused'));
      const url = uniqueUrl('dead-letter');
      const secret = 'subscriber-secret-b';
      const subscription = createWebhookSubscription(url, secret);

      await expect(dispatchEventWebhook('milestone_approved', { milestoneId: 'm1' })).resolves.toBeUndefined();

      const deadLetters = listWebhookDeadLetters(100, 0);
      const match = deadLetters.find((d) => d.url === url);
      expect(match).toBeDefined();
      expect(match!.subscription_id).toBe(subscription.id);
      expect(match!.event_type).toBe('milestone_approved');
      expect(JSON.parse(match!.payload)).toEqual({
        eventType: 'milestone_approved',
        payload: { milestoneId: 'm1' },
      });
      expect(match!.failure_reason).toContain('connection refused');
      expect(match!.attempts).toBe(3);
      expect(match!.status).toBe('pending');
    },
    15000
  );

  it(
    'dead-letters only the subscriber that fails when multiple subscriptions are registered',
    async () => {
      const okUrl = uniqueUrl('ok');
      const failingUrl = uniqueUrl('fail');
      createWebhookSubscription(okUrl, 'secret-ok');
      createWebhookSubscription(failingUrl, 'secret-fail');

      mockedFetch.mockImplementation(async (url) => {
        if (url === failingUrl) {
          throw new Error('subscriber unreachable');
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { ok: true, status: 200 } as any;
      });

      await dispatchEventWebhook('scout_subscribed', { scout: 'S1' });

      const deadLetters = listWebhookDeadLetters(100, 0);
      expect(deadLetters.find((d) => d.url === failingUrl)).toBeDefined();
      expect(deadLetters.find((d) => d.url === okUrl)).toBeUndefined();
    },
    15000
  );
});
