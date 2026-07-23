/**
 * Search cache.
 *
 * Backend is selected once at module load based on `REDIS_URL`:
 *   - set   -> RedisCacheStore — cache state is shared across every backend
 *              instance, so a load-balanced multi-instance deployment stays
 *              consistent instead of each process re-hitting IPFS/DB.
 *   - unset -> InMemoryCacheStore — process-local, zero setup. Default for
 *              local dev and CI.
 *
 * Cache key conventions:
 *   players:list:<hash>  – paginated player search results (keyed by filter params)
 *   players:<playerId>   – single player profile
 *   milestones:<playerId> – milestone list for a player
 *
 * All exported functions are async: Redis access is inherently network I/O,
 * so every call site must `await` these calls (they returned void
 * synchronously before this module supported a Redis backend).
 */
import Redis from 'ioredis';
import config from '../config';
import { CacheStore } from './cacheStore';
import { InMemoryCacheStore } from './inMemoryCacheStore';
import { RedisCacheStore } from './redisCacheStore';
import { recordCacheHit, recordCacheMiss } from '../middleware/metrics';

function createStore(): CacheStore {
  if (config.redisUrl) {
    return new RedisCacheStore(new Redis(config.redisUrl));
  }
  return new InMemoryCacheStore();
}

const store: CacheStore = createStore();

/** Fetch a cached value. Returns undefined if missing or expired. */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  const value = await store.get<T>(key);
  if (value !== undefined) {
    recordCacheHit();
  } else {
    recordCacheMiss();
  }
  return value;
}

/** Store a value under `key`, expiring after `ttlMs` (default: config.playerCacheTtlMs). */
export async function cacheSet<T>(
  key: string,
  value: T,
  ttlMs: number = config.playerCacheTtlMs
): Promise<void> {
  await store.set(key, value, ttlMs);
}

export async function invalidatePlayerCache(playerId?: string): Promise<void> {
  await store.deleteByPrefix('players:list');
  if (playerId) {
    await store.del(`players:${playerId}`);
  }
}

export async function invalidateMilestoneCache(playerId: string): Promise<void> {
  await store.del(`milestones:${playerId}`);
  // Also bust the player list so updated progress tier is reflected
  await invalidatePlayerCache(playerId);
}
