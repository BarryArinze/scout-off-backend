import type Redis from 'ioredis';
import { CacheStore } from './cacheStore';

const SCAN_COUNT = 100;

/**
 * Minimal surface of the ioredis client this store relies on. Declared
 * explicitly (rather than depending on the full `Redis` class) so tests can
 * substitute a lightweight fake (e.g. ioredis-mock) without needing a real
 * type-compatible client.
 */
export type RedisLike = Pick<Redis, 'get' | 'set' | 'del' | 'exists' | 'scan' | 'pipeline'>;

/**
 * Redis-backed cache store for multi-instance deployments — cache state is
 * shared across every backend process instead of living in a single
 * process's memory.
 *
 * Values are JSON-serialized. TTL is delegated to Redis's native `PX` expiry
 * (`SET key value PX ttlMs`) rather than tracked in JS, so a key genuinely
 * disappears from Redis at expiry and reads return undefined — the same
 * observable behavior as the in-memory store.
 *
 * `deleteByPrefix` uses `SCAN ... MATCH <prefix>*` in a cursor loop (never
 * `KEYS *`, which blocks the whole server) and pipelines the deletes.
 */
export class RedisCacheStore implements CacheStore {
  constructor(private readonly client: RedisLike) {}

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(key);
    if (raw === null || raw === undefined) return undefined;
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlMs !== undefined) {
      await this.client.set(key, serialized, 'PX', ttlMs);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async has(key: string): Promise<boolean> {
    const exists = await this.client.exists(key);
    return exists === 1;
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        SCAN_COUNT
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.client.pipeline();
        for (const key of keys) pipeline.del(key);
        await pipeline.exec();
      }
    } while (cursor !== '0');
  }
}
