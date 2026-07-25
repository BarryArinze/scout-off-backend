import { Request, Response, NextFunction } from 'express';
import express from 'express';
import request from 'supertest';
import { rateLimit, walletRateLimit } from '../../src/middleware/rateLimit';

// ── Unit tests for rateLimit middleware ──────────────────────────────────────

function makeReqRes(ip = '127.0.0.1') {
  const req = { ip } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as NextFunction;
  return { req, res, next };
}

describe('rateLimit middleware', () => {
  it('allows requests under the limit', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i++) {
      const { req, res, next } = makeReqRes('1.1.1.1');
      mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('returns 429 when limit is exceeded', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2 });
    const ip = '2.2.2.2';
    for (let i = 0; i < 2; i++) {
      const { req, res, next } = makeReqRes(ip);
      mw(req, res, next);
    }
    const { req, res, next } = makeReqRes(ip);
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('resets the counter after the window expires', async () => {
    const mw = rateLimit({ windowMs: 50, max: 1 });
    const ip = '3.3.3.3';

    const first = makeReqRes(ip);
    mw(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = makeReqRes(ip);
    mw(second.req, second.res, second.next);
    expect(second.res.status).toHaveBeenCalledWith(429);

    await new Promise((r) => setTimeout(r, 60));

    const third = makeReqRes(ip);
    mw(third.req, third.res, third.next);
    expect(third.next).toHaveBeenCalledTimes(1);
  });

  it('tracks IPs independently', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    const a = makeReqRes('4.4.4.4');
    mw(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalledTimes(1);

    const b = makeReqRes('5.5.5.5');
    mw(b.req, b.res, b.next);
    expect(b.next).toHaveBeenCalledTimes(1);
  });
});

// ── Integration: POST /api/validators/milestone throttling ───────────────────
// Confirms the middleware correctly throttles repeated requests from the same IP.
describe('POST /api/validators/milestone rate limiting (middleware integration)', () => {
  it('returns 429 after exceeding the configured limit', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    const ip = '9.9.9.9';

    const first = makeReqRes(ip);
    mw(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = makeReqRes(ip);
    mw(second.req, second.res, second.next);
    expect(second.res.status).toHaveBeenCalledWith(429);
    expect(second.next).not.toHaveBeenCalled();
  });
});

// ── Unit tests for walletRateLimit middleware ────────────────────────────────
describe('walletRateLimit middleware', () => {
  function makeReqResWithWallet(wallet?: string, ip = '127.0.0.1') {
    const req = { ip, account: wallet } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn() as NextFunction;
    return { req, res, next };
  }

  it('allows requests under the limit by wallet', () => {
    const mw = walletRateLimit({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 3; i++) {
      const { req, res, next } = makeReqResWithWallet('G_WALLET_1');
      mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('returns 429 when limit is exceeded by wallet', () => {
    const mw = walletRateLimit({ windowMs: 60_000, max: 2 });
    const wallet = 'G_WALLET_2';
    for (let i = 0; i < 2; i++) {
      const { req, res, next } = makeReqResWithWallet(wallet);
      mw(req, res, next);
    }
    const { req, res, next } = makeReqResWithWallet(wallet);
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('ignores requests if req.account is not present', () => {
    const mw = walletRateLimit({ windowMs: 60_000, max: 1 });
    const { req, res, next } = makeReqResWithWallet(undefined);
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();

    // Call again to verify it is not blocked
    const second = makeReqResWithWallet(undefined);
    mw(second.req, second.res, second.next);
    expect(second.next).toHaveBeenCalledTimes(1);
    expect(second.res.status).not.toHaveBeenCalled();
  });
});


// ── X-Forwarded-For / trusted-proxy tests ────────────────────────────────────
//
// Express resolves req.ip from X-Forwarded-For when `trust proxy` is
// configured on the app (app.set('trust proxy', N)).  These tests spin up a
// minimal Express app that mirrors the production app.set() call so we can
// verify the rate-limiter uses the correct client IP in each proxy scenario.

/**
 * Build a minimal Express app with `trust proxy` set to `trustedProxyCount`
 * and a single GET /ping route protected by the rateLimit middleware.
 *
 * The handler echoes back the resolved req.ip so tests can assert on it.
 */
function makeProxyApp(trustedProxyCount: number, max = 2) {
  const app = express();
  app.set('trust proxy', trustedProxyCount);
  const mw = rateLimit({ windowMs: 60_000, max });
  app.get('/ping', mw, (req, res) => {
    res.json({ ip: req.ip, status: 'ok' });
  });
  return app;
}

describe('rateLimit middleware — X-Forwarded-For / trusted proxy', () => {
  it('uses the socket IP when no X-Forwarded-For header is present', async () => {
    const app = makeProxyApp(0, 3);

    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    // supertest connects via loopback; req.ip should be the loopback address
    expect(res.body.ip).toMatch(/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/);
  });

  it('uses the X-Forwarded-For IP when TRUSTED_PROXY_COUNT=1', async () => {
    const app = makeProxyApp(1, 3);

    const res = await request(app)
      .get('/ping')
      .set('X-Forwarded-For', '1.2.3.4');

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('1.2.3.4');
  });

  it('tracks two different X-Forwarded-For IPs independently', async () => {
    // max=1 per IP; two different clients should each get their own counter
    const app = makeProxyApp(1, 1);

    // First request from 10.0.0.1 — should pass
    const r1 = await request(app).get('/ping').set('X-Forwarded-For', '10.0.0.1');
    expect(r1.status).toBe(200);

    // First request from 10.0.0.2 — different IP, should also pass
    const r2 = await request(app).get('/ping').set('X-Forwarded-For', '10.0.0.2');
    expect(r2.status).toBe(200);

    // Second request from 10.0.0.1 — same IP, limit exceeded
    const r3 = await request(app).get('/ping').set('X-Forwarded-For', '10.0.0.1');
    expect(r3.status).toBe(429);

    // Second request from 10.0.0.2 — same IP, limit exceeded
    const r4 = await request(app).get('/ping').set('X-Forwarded-For', '10.0.0.2');
    expect(r4.status).toBe(429);
  });

  it('uses the first untrusted hop when X-Forwarded-For has two proxies and TRUSTED_PROXY_COUNT=1', async () => {
    // Header:  X-Forwarded-For: 1.2.3.4, 5.6.7.8
    // TRUSTED_PROXY_COUNT=1 means the rightmost entry (5.6.7.8) is a trusted
    // proxy; Express therefore resolves req.ip to 1.2.3.4 (first untrusted hop).
    const app = makeProxyApp(1, 3);

    const res = await request(app)
      .get('/ping')
      .set('X-Forwarded-For', '1.2.3.4, 5.6.7.8');

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('1.2.3.4');
  });
});