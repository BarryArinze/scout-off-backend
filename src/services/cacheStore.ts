/**
 * Pluggable cache backend interface.
 *
 * Implementations may be purely synchronous internally (e.g. the in-memory
 * Map) or require a network round-trip (e.g. Redis). Every method returns a
 * Promise so both kinds of backend are interchangeable behind a single
 * async API — callers never need to know which backend is active.
 */
export interface CacheStore {
  /** Fetch a value by key. Returns undefined if missing or expired. */
  get<T>(key: string): Promise<T | undefined>;

  /**
   * Store a value under `key`. If `ttlMs` is provided the entry expires
   * (and reads/has() checks stop seeing it) after that many milliseconds;
   * omitted means the entry never expires on its own.
   */
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;

  /** Remove a single key. No-op if the key does not exist. */
  del(key: string): Promise<void>;

  /** Whether a (non-expired) value currently exists for `key`. */
  has(key: string): Promise<boolean>;

  /**
   * Remove every key starting with `prefix`. Used to invalidate whole
   * families of keys (e.g. every paginated `players:list:*` entry) without
   * needing to track each exact key that was ever written.
   */
  deleteByPrefix(prefix: string): Promise<void>;
}
