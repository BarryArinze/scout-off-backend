import { Request, Response, NextFunction } from 'express';
import net from 'net';
import { extractClientIp } from '../utils/ipExtractor';
import { logger } from '../utils/logger';

/**
 * Convert a dotted-decimal IPv4 string to an unsigned 32-bit integer.
 * Callers must ensure `ip` is a valid IPv4 address first (e.g. via
 * `net.isIP(ip) === 4`) — this does not validate its input.
 */
function ipToNumber(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) | parseInt(oct, 10), 0) >>> 0;
}

/**
 * Check whether a given IPv4 address falls within a CIDR range or matches
 * an exact IP. Only IPv4 is supported; non-IPv4 input (e.g. IPv6) always
 * fails the match so callers fail closed rather than silently miscomputing
 * a value for it.
 *
 * @param ip   - Client IP in dotted-decimal notation (e.g. "192.168.1.42")
 * @param cidr - Entry from the allowlist, either "x.x.x.x" or "x.x.x.x/n"
 */
function ipInCidr(ip: string, cidr: string): boolean {
  if (net.isIP(ip) !== 4) return false;
  if (!cidr.includes('/')) return ip === cidr;
  const [network, prefixStr] = cidr.split('/');
  if (net.isIP(network) !== 4) return false;
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipToNumber(ip) & mask) === (ipToNumber(network) & mask);
}

/**
 * Middleware that enforces an IP allowlist for admin endpoints.
 *
 * Reads the `ADMIN_IP_ALLOWLIST` environment variable, which should be a
 * comma-separated list of IPv4 addresses or CIDR ranges
 * (e.g. "192.168.1.0/24,10.0.0.1").
 *
 * Behaviour:
 * - When `ADMIN_IP_ALLOWLIST` is **not set** (or empty), all requests pass
 *   through — preserving backwards compatibility.
 * - Only IPv4 is supported. A client IP that resolves to IPv6 is rejected
 *   with 403 regardless of the configured allowlist (fail closed), rather
 *   than being silently coerced to 0 for CIDR matching.
 * - When set, requests whose client IP is **not** in the list are rejected
 *   with HTTP 403.
 *
 * The client IP is extracted via `extractClientIp`, which honours the
 * `X-Forwarded-For` header and the `TRUSTED_PROXY_COUNT` configuration.
 */
export function ipAllowlistMiddleware(req: Request, res: Response, next: NextFunction): void {
  const raw = process.env.ADMIN_IP_ALLOWLIST;

  // No allowlist configured — pass through (backwards compatible)
  if (!raw || raw.trim() === '') {
    next();
    return;
  }

  const allowlist = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // If all entries were whitespace/empty after trimming, treat as unset
  if (allowlist.length === 0) {
    next();
    return;
  }

  const clientIp = extractClientIp(req);

  // The allowlist only supports IPv4 addresses/CIDR ranges. Reject IPv6
  // clients explicitly (fail closed) instead of letting them silently
  // coerce to 0 in ipToNumber()/ipInCidr().
  if (net.isIP(clientIp) === 6) {
    logger.warn({
      method: req.method,
      path: req.path,
      clientIp,
      error: 'IPv6 client IP is not supported by ADMIN_IP_ALLOWLIST; denying by default',
    });
    res.status(403).json({ success: false, error: 'Forbidden: IPv6 addresses are not supported by the IP allowlist' });
    return;
  }

  const allowed = allowlist.some((entry) => ipInCidr(clientIp, entry));

  if (!allowed) {
    logger.warn({ method: req.method, path: req.path, clientIp, error: 'IP not in allowlist' });
    res.status(403).json({ success: false, error: 'Forbidden: IP not in allowlist' });
    return;
  }

  next();
}
