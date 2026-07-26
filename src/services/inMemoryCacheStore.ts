import { CacheStore } from './cacheStore';
import { recordCacheEviction } from '../middleware/metrics';

interface Entry {
  value: unknown;
  expiresAt?: number;
}

/**
 * Process-local cache backend. Default when no REDIS_URL is configured —
 * suitable for local dev, CI, and single-instance deployments. State is not
 * shared across processes, which is exactly the limitation Redis mode fixes.
 */
export class InMemoryCacheStore implements CacheStore {
  private store = new Map<string, Entry>();

  private isExpired(entry: Entry): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      recordCacheEviction();
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}
