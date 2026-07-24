/**
 * Tests for issue #280 — dedicated, tighter rate limit on auth endpoints.
 */

import { Request, Response, NextFunction } from 'express';
import { rateLimit } from '../../src/middleware/rateLimit';

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

describe('auth rate limit — tighter limit (5/min default)', () => {
  it('allows requests up to the auth limit', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 5 });
    const ip = '10.0.0.1';
    for (let i = 0; i < 5; i++) {
      const { req, res, next } = makeReqRes(ip);
      mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
  });

  it('returns 429 on the 6th request within the window', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 5 });
    const ip = '10.0.0.2';
    for (let i = 0; i < 5; i++) {
      const { req, res, next } = makeReqRes(ip);
      mw(req, res, next);
    }
    const { req, res, next } = makeReqRes(ip);
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('includes Retry-After header when limit is exceeded', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    const ip = '10.0.0.3';

    const first = makeReqRes(ip);
    mw(first.req, first.res, first.next);

    const second = makeReqRes(ip);
    mw(second.req, second.res, second.next);

    expect(second.res.status).toHaveBeenCalledWith(429);
    expect(second.res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
    const retryAfter = (second.res.set as jest.Mock).mock.calls.find(
      ([h]: [string]) => h === 'Retry-After'
    )?.[1];
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it('auth limit is independent from the default limit applied to other routes', () => {
    const defaultMw = rateLimit({ windowMs: 60_000, max: 60 });
    const authMw = rateLimit({ windowMs: 60_000, max: 5 });
    const ip = '10.0.0.4';

    // exhaust the auth limit
    for (let i = 0; i < 5; i++) {
      const { req, res, next } = makeReqRes(ip);
      authMw(req, res, next);
    }
    const blocked = makeReqRes(ip);
    authMw(blocked.req, blocked.res, blocked.next);
    expect(blocked.res.status).toHaveBeenCalledWith(429);

    // same IP on the default middleware is still fine (different instance / counter)
    const defaultReq = makeReqRes(ip);
    defaultMw(defaultReq.req, defaultReq.res, defaultReq.next);
    expect(defaultReq.next).toHaveBeenCalledTimes(1);
  });
});

describe('auth rate limit — independence and window reset', () => {
  it('exactly 5 auth requests within a window all succeed and the 6th is rejected', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 5 });
    const ip = '10.1.0.1';

    // All 5 should pass
    for (let i = 0; i < 5; i++) {
      const { req, res, next } = makeReqRes(ip);
      mw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }

    // The 6th must be blocked
    const { req, res, next } = makeReqRes(ip);
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('6 non-auth requests all succeed when the global limit is 60', () => {
    const globalMw = rateLimit({ windowMs: 60_000, max: 60 });
    const ip = '10.1.0.2';

    for (let i = 0; i < 6; i++) {
      const { req, res, next } = makeReqRes(ip);
      globalMw(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it('429 response always includes a positive numeric Retry-After header', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    const ip = '10.1.0.3';

    // Exhaust the limit
    const first = makeReqRes(ip);
    mw(first.req, first.res, first.next);

    // Trigger 429
    const second = makeReqRes(ip);
    mw(second.req, second.res, second.next);

    expect(second.res.status).toHaveBeenCalledWith(429);
    expect(second.res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));

    const retryAfterCall = (second.res.set as jest.Mock).mock.calls.find(
      ([h]: [string]) => h === 'Retry-After'
    );
    expect(retryAfterCall).toBeDefined();
    const retryAfterValue = Number(retryAfterCall![1]);
    expect(retryAfterValue).toBeGreaterThan(0);
  });

  it('allows requests again after the rate limit window resets', async () => {
    const mw = rateLimit({ windowMs: 50, max: 2 });
    const ip = '10.1.0.4';

    // Exhaust the limit
    for (let i = 0; i < 2; i++) {
      const { req, res, next } = makeReqRes(ip);
      mw(req, res, next);
    }

    // Confirm it is blocked
    const blocked = makeReqRes(ip);
    mw(blocked.req, blocked.res, blocked.next);
    expect(blocked.res.status).toHaveBeenCalledWith(429);

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Should be allowed again after reset
    const { req, res, next } = makeReqRes(ip);
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('disables rate limiting when config.rateLimit.enabled is false', () => {
    // Mutate the live config object to simulate RATE_LIMIT_ENABLED=false
    const configModule = require('../../src/config');
    const original = configModule.default.rateLimit.enabled;
    configModule.default.rateLimit.enabled = false;

    try {
      // max is intentionally 1 — every request beyond the first would normally be blocked
      const mw = rateLimit({ windowMs: 60_000, max: 1 });
      const ip = '10.9.9.9';

      for (let i = 0; i < 6; i++) {
        const { req, res, next } = makeReqRes(ip);
        mw(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
      }
    } finally {
      // Always restore original value so other tests are unaffected
      configModule.default.rateLimit.enabled = original;
    }
  });
});
