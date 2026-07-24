import { extractClientIp } from '../../src/utils/ipExtractor';
import { Request } from 'express';

function makeReq(headers: Record<string, string>, remoteAddress = '10.0.0.1'): Request {
  return {
    headers,
    socket: { remoteAddress },
  } as unknown as Request;
}

describe('extractClientIp', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, TRUSTED_PROXY_COUNT: '1' };
    jest.resetModules();
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('returns remoteAddress when no x-forwarded-for header', () => {
    const req = makeReq({}, '1.2.3.4');
    expect(extractClientIp(req)).toBe('1.2.3.4');
  });

  it('extracts client IP from x-forwarded-for with one trusted proxy', () => {
    // "client, proxy1" — proxy1 is trusted, so client is the real IP
    const req = makeReq({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' });
    expect(extractClientIp(req)).toBe('203.0.113.5');
  });

  it('handles single IP in x-forwarded-for', () => {
    const req = makeReq({ 'x-forwarded-for': '203.0.113.5' });
    expect(extractClientIp(req)).toBe('203.0.113.5');
  });

  it('returns unknown when no address available', () => {
    const req = {
      headers: {},
      socket: { remoteAddress: undefined },
    } as unknown as Request;
    expect(extractClientIp(req)).toBe('unknown');
  });
});

// ─── Fail-safe: under-populated X-Forwarded-For chain ────────────────────────
//
// When the real proxy hop count is fewer than TRUSTED_PROXY_COUNT implies,
// the leftmost value in X-Forwarded-For is attacker-controlled (the client
// can freely craft it).  extractClientIp() must NOT return that value.
// Instead it falls back to req.socket.remoteAddress.

describe('extractClientIp — fail-safe for under-populated X-Forwarded-For', () => {
  const OLD_ENV = process.env;
  const SOCKET_ADDR = '172.16.0.1';

  afterAll(() => {
    process.env = OLD_ENV;
  });

  function makeReqWithSocket(xff: string, remoteAddress = SOCKET_ADDR): Request {
    return {
      headers: { 'x-forwarded-for': xff },
      socket: { remoteAddress },
    } as unknown as Request;
  }

  it('falls back to socket address when XFF has fewer hops than TRUSTED_PROXY_COUNT=2', () => {
    process.env.TRUSTED_PROXY_COUNT = '2';
    jest.resetModules();
    // TRUSTED_PROXY_COUNT=2 expects: [client, proxy1, proxy2] = 3 entries.
    // Only 1 entry provided — attacker-controlled leftmost value.
    const req = makeReqWithSocket('203.0.113.99');
    const { extractClientIp: fn } = jest.requireActual('../../src/utils/ipExtractor') as typeof import('../../src/utils/ipExtractor');
    // We call the module-level function which reads env at module load time,
    // so we re-import it after resetting modules.
    expect(fn(req)).not.toBe('203.0.113.99');
    expect(fn(req)).toBe(SOCKET_ADDR);
  });

  it('does NOT return attacker-supplied IP from a 1-entry XFF when TRUSTED_PROXY_COUNT=1', () => {
    process.env.TRUSTED_PROXY_COUNT = '1';
    jest.resetModules();
    // TRUSTED_PROXY_COUNT=1 requires [client, proxy1] = 2 entries.
    // Only 1 entry — should fall back.
    const attackerIp = '1.3.3.7';
    const req = makeReqWithSocket(attackerIp);
    const { extractClientIp: fn } = jest.requireActual('../../src/utils/ipExtractor') as typeof import('../../src/utils/ipExtractor');
    expect(fn(req)).not.toBe(attackerIp);
    expect(fn(req)).toBe(SOCKET_ADDR);
  });

  it('returns correct client IP when XFF exactly matches expected chain length', () => {
    process.env.TRUSTED_PROXY_COUNT = '2';
    jest.resetModules();
    // TRUSTED_PROXY_COUNT=2: expects [client, proxy1, proxy2] = 3 entries.
    const req = makeReqWithSocket('203.0.113.5, 10.0.0.1, 10.0.0.2');
    const { extractClientIp: fn } = jest.requireActual('../../src/utils/ipExtractor') as typeof import('../../src/utils/ipExtractor');
    expect(fn(req)).toBe('203.0.113.5');
  });

  it('returns socket address when XFF is empty string', () => {
    process.env.TRUSTED_PROXY_COUNT = '1';
    jest.resetModules();
    const req = makeReqWithSocket('');
    const { extractClientIp: fn } = jest.requireActual('../../src/utils/ipExtractor') as typeof import('../../src/utils/ipExtractor');
    // Empty string splits to [''] which has length 1 < TRUSTED_PROXY_COUNT+1=2
    expect(fn(req)).toBe(SOCKET_ADDR);
  });

  it('returns socket address when there is no socket address either (ultimate fallback)', () => {
    process.env.TRUSTED_PROXY_COUNT = '2';
    jest.resetModules();
    const req = {
      headers: { 'x-forwarded-for': '1.2.3.4' },
      socket: { remoteAddress: undefined },
    } as unknown as Request;
    const { extractClientIp: fn } = jest.requireActual('../../src/utils/ipExtractor') as typeof import('../../src/utils/ipExtractor');
    expect(fn(req)).toBe('unknown');
  });
});
