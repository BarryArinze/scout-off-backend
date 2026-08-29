/**
 * Feature flag service.
 *
 * Flags are read from the `feature_flags` table (key/value rows). On first
 * access the table is created (if absent) and the default rows are seeded.
 * Reading is synchronous so callers get a plain boolean with no await.
 *
 * Toggle behaviour: flags are evaluated **at request time** (dynamic). Changing
 * a row in the database takes effect on the next request with no restart
 * required. The cache TTL (default 5 s) bounds the read frequency.
 */

import { getDb } from '../db';
import { logger } from '../utils/logger';

// ─── Flag names ───────────────────────────────────────────────────────────────

/** Controls whether the /graphql endpoint is mounted. Off by default. */
export const GRAPHQL_ENABLED = 'graphql_enabled';

// ─── Default values ───────────────────────────────────────────────────────────

const DEFAULTS: Record<string, boolean> = {
  [GRAPHQL_ENABLED]: false,
};

// ─── Schema bootstrap ─────────────────────────────────────────────────────────

/** Ensure the feature_flags table exists and seed default rows. */
export function bootstrapFeatureFlags(): void {
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        key        TEXT PRIMARY KEY,
        enabled    INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      )
    `);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO feature_flags (key, enabled)
      VALUES (?, ?)
    `);
    for (const [key, value] of Object.entries(DEFAULTS)) {
      insert.run(key, value ? 1 : 0);
    }
  } catch (err) {
    logger.warn({ err }, '[featureFlags] bootstrap failed — flags will use in-memory defaults');
  }
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Cache TTL in milliseconds (default 5 s). Override via FEATURE_FLAG_CACHE_TTL_MS. */
function cacheTtlMs(): number {
  return parseInt(process.env.FEATURE_FLAG_CACHE_TTL_MS ?? '5000', 10);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read the current value of a feature flag.
 *
 * @param key - Flag name constant (e.g. `GRAPHQL_ENABLED`)
 * @returns `true` when the flag is enabled, `false` otherwise
 */
export function isEnabled(key: string): boolean {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let value = DEFAULTS[key] ?? false;
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT enabled FROM feature_flags WHERE key = ?')
      .get(key) as { enabled: number } | undefined;
    if (row !== undefined) {
      value = row.enabled !== 0;
    }
  } catch {
    // DB may not be initialised during tests; fall back to defaults silently.
  }

  cache.set(key, { value, expiresAt: now + cacheTtlMs() });
  return value;
}

/**
 * Set a feature flag value. Writes through to the database and clears the
 * cache entry so the new value is visible on the next call to `isEnabled`.
 */
export function setFlag(key: string, enabled: boolean): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO feature_flags (key, enabled, updated_at)
         VALUES (?, ?, strftime('%s', 'now'))
         ON CONFLICT(key) DO UPDATE SET
           enabled    = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(key, enabled ? 1 : 0);
  } catch (err) {
    logger.warn({ err }, '[featureFlags] setFlag DB write failed');
  }
  cache.delete(key);
}

/** Flush the in-memory cache. Useful in tests. */
export function clearFlagCache(): void {
  cache.clear();
}
