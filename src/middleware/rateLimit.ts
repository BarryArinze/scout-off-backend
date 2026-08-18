import { Request, Response, NextFunction } from 'express';
import config from '../config';
import { RateLimitStore } from './rateLimitStore';
import { InMemoryRateLimitStore } from './inMemoryRateLimitStore';
import { RedisRateLimitStore } from './redisRateLimitStore';
import { getRedisClient } from '../services/redis';
import { logger } from '../utils/logger';

function createStore(): RateLimitStore {
  const redis = getRedisClient();
  if (redis) {
    return new RedisRateLimitStore(redis);
  }
  return new InMemoryRateLimitStore();
}

const defaultStore: RateLimitStore = createStore();

export interface RateLimitOptions {
  windowMs?: number; // time window in ms (default: config.rateLimit.windowMs)
  max?: number;      // max requests per window per IP (default: config.rateLimit.max)
  store?: RateLimitStore; // override default store (useful for tests)
  /**
   * Namespace distinguishing this limiter's counters from every other
   * rateLimit() instance sharing the same default store. Without this,
   * two differently-configured limiters (e.g. auth vs. milestone
   * submission) would increment the exact same `ip:<ip>` counter and
   * enforce whichever limiter's `max` is lowest against ALL of that IP's
   * traffic, not just the traffic for that specific limiter. Defaults to
   * 'default' for backward compatibility with any caller that doesn't need
   * isolation from other limiters.
   */
  name?: string;
}

/**
 * Simple in-process or Redis-backed IP-based rate limiter.
 * Configurable via windowMs and max; excess requests return HTTP 429.
 *
 * ## Fail-open policy
 *
 * When the backing store (Redis) raises an error, the request is *allowed*
 * rather than rejected.  This is an explicit availability-over-security
 * trade-off: a Redis outage temporarily disables distributed throttling
 * rather than taking all API endpoints offline.
 *
 * Rationale:
 * - The protected endpoints are public APIs and auth endpoints that must
 *   remain available to legitimate users even during infrastructure failures.
 * - A Redis outage is not itself an attack vector — an attacker who takes
 *   down Redis would already have significant infrastructure access.
 * - During a Redis outage the in-process InMemoryRateLimitStore does NOT
 *   automatically kick in; operators should monitor Redis availability.
 * - The fail-open decision is logged at `warn` level so operators can detect
 *   and respond to Redis problems.
 *
 * If a future security review requires fail-closed behavior for specific
 * routes, pass a custom `store` that implements the fail-closed policy.
 */
export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? config.rateLimit.windowMs;
  const max = options.max ?? config.rateLimit.max;
  const store = options.store ?? defaultStore;
  const namespace = options.name ?? 'default';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.rateLimit.enabled) {
      next();
      return;
    }
    const ip = req.ip ?? 'unknown';

    try {
      const { count, resetAt } = await store.increment(`${namespace}:ip:${ip}`, windowMs);

      if (count > max) {
        const now = Date.now();
        const retryAfterSec = Math.ceil(Math.max(0, resetAt - now) / 1000);
        res.set('Retry-After', String(retryAfterSec || 1));
        res.status(429).json({ success: false, error: 'Too many requests, please try again later' });
        return;
      }
      next();
    } catch (err) {
      // Redis (or other store) error: fail open — allow the request rather
      // than returning a 500.  Log at warn so operators can investigate.
      logger.warn('[rate-limit] store error, failing open', { ip, err });
      next();
    }
  };
}

/**
 * Simple in-process or Redis-backed wallet-based rate limiter.
 * Configurable via windowMs and max; excess requests return HTTP 429.
 * If req.account is not present, it calls next().
 *
 * Inherits the same fail-open policy as `rateLimit` — see above.
 */
export function walletRateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? config.rateLimit.windowMs;
  const max = options.max ?? config.rateLimit.max;
  const store = options.store ?? defaultStore;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.rateLimit.enabled) {
      next();
      return;
    }
    const wallet = req.account;
    if (!wallet) {
      next();
      return;
    }

    try {
      const { count } = await store.increment(`wallet:${wallet}`, windowMs);

      if (count > max) {
        res.status(429).json({ success: false, error: 'Too many requests, please try again later' });
        return;
      }
      next();
    } catch (err) {
      // Redis (or other store) error: fail open.
      logger.warn('[rate-limit] store error, failing open', { wallet, err });
      next();
    }
  };
}
