import { Request, Response, NextFunction } from 'express';
import { ipAllowlistMiddleware } from '../../src/middleware/ipAllowlist';

/**
 * Build minimal mock req / res / next objects.
 *
 * @param remoteIp       - req.socket.remoteAddress value
 * @param xForwardedFor  - optional X-Forwarded-For header value
 */
function makeReqRes(remoteIp: string, xForwardedFor?: string) {
  const req = {
    method: 'GET',
    path: '/api/admin/stats',
    headers: xForwardedFor ? { 'x-forwarded-for': xForwardedFor } : {},
    socket: { remoteAddress: remoteIp },
  } as unknown as Request;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;

  const next = jest.fn() as NextFunction;

  return { req, res, next };
}

describe('ipAllowlistMiddleware', () => {
  const ORIGINAL_ENV = process.env.ADMIN_IP_ALLOWLIST;

  afterEach(() => {
    // Restore env after each test
    if (ORIGINAL_ENV === undefined) {
      delete process.env.ADMIN_IP_ALLOWLIST;
    } else {
      process.env.ADMIN_IP_ALLOWLIST = ORIGINAL_ENV;
    }
  });

  // ------------------------------------------------------------------
  // Test 1: no allowlist configured → all IPs pass through
  // ------------------------------------------------------------------
  it('calls next() for any IP when ADMIN_IP_ALLOWLIST is not set', () => {
    delete process.env.ADMIN_IP_ALLOWLIST;

    const { req, res, next } = makeReqRes('203.0.113.42');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Test 2: allowlist is set and client IP is in the list → pass through
  // ------------------------------------------------------------------
  it('calls next() when client IP is explicitly in the allowlist', () => {
    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.1,192.168.1.100';

    const { req, res, next } = makeReqRes('10.0.0.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // Test 3: allowlist is set and client IP is NOT in the list → 403
  // ------------------------------------------------------------------
  it('returns 403 when client IP is not in the allowlist', () => {
    process.env.ADMIN_IP_ALLOWLIST = '10.0.0.1,192.168.1.100';

    const { req, res, next } = makeReqRes('203.0.113.99');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Forbidden: IP not in allowlist',
    });
  });

  // ------------------------------------------------------------------
  // Test 4: CIDR range matching
  // ------------------------------------------------------------------
  it('allows an IP that falls within a CIDR range', () => {
    process.env.ADMIN_IP_ALLOWLIST = '192.168.1.0/24';

    // 192.168.1.55 is inside 192.168.1.0/24
    const allowed = makeReqRes('192.168.1.55');
    ipAllowlistMiddleware(allowed.req, allowed.res, allowed.next);
    expect(allowed.next).toHaveBeenCalledTimes(1);
    expect(allowed.res.status).not.toHaveBeenCalled();
  });

  it('blocks an IP that falls outside the CIDR range', () => {
    process.env.ADMIN_IP_ALLOWLIST = '192.168.1.0/24';

    // 192.168.2.1 is outside 192.168.1.0/24
    const blocked = makeReqRes('192.168.2.1');
    ipAllowlistMiddleware(blocked.req, blocked.res, blocked.next);
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.status).toHaveBeenCalledWith(403);
  });

  // ------------------------------------------------------------------
  // Test 5: X-Forwarded-For header is respected
  // ------------------------------------------------------------------
  it('uses X-Forwarded-For to determine the client IP', () => {
    // TRUSTED_PROXY_COUNT defaults to 1 in ipExtractor.ts.
    // With header "198.51.100.5, 10.10.10.1" (client, proxy) and
    // TRUSTED_PROXY_COUNT=1, the real IP is at index length-1-1 = 0,
    // so the real IP is 198.51.100.5.
    process.env.TRUSTED_PROXY_COUNT = '1';
    process.env.ADMIN_IP_ALLOWLIST = '198.51.100.5';

    const { req, res, next } = makeReqRes('10.10.10.1', '198.51.100.5, 10.10.10.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();

    // Cleanup TRUSTED_PROXY_COUNT
    delete process.env.TRUSTED_PROXY_COUNT;
  });

  it('blocks a forwarded IP that is not in the allowlist', () => {
    process.env.TRUSTED_PROXY_COUNT = '1';
    process.env.ADMIN_IP_ALLOWLIST = '198.51.100.5';

    // The client IP extracted from X-Forwarded-For will be 203.0.113.7
    const { req, res, next } = makeReqRes('10.10.10.1', '203.0.113.7, 10.10.10.1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);

    delete process.env.TRUSTED_PROXY_COUNT;
  });

  // ------------------------------------------------------------------
  // Test 6: IPv6 client IP must be rejected explicitly, not silently
  // miscomputed to 0.
  // ------------------------------------------------------------------
  it('rejects an IPv6 client IP explicitly instead of silently coercing it to 0', () => {
    // 0.0.0.0/0 would match every IPv4 address (and would also have
    // matched the old NaN|0 -> 0 coercion for an IPv6 client).
    process.env.ADMIN_IP_ALLOWLIST = '0.0.0.0/0';

    const { req, res, next } = makeReqRes('2001:db8::1');
    ipAllowlistMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Forbidden: IPv6 addresses are not supported by the IP allowlist',
    });
  });
});
