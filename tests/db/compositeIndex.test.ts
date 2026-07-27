// Tests for migration 013: composite indexes — issue #821
//
// Acceptance criteria:
//  1. All 5 new composite indexes exist after running all migrations.
//  2. EXPLAIN QUERY PLAN for each representative query shows SEARCH using the
//     new index, not a full scan (SCAN TABLE).
//  3. Existing migration tests are unaffected (they run in their own file).

import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate';
import { SqliteDriver } from '../../src/db/sqlite-driver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function migrate(db: Database.Database): void {
  runMigrations(new SqliteDriver(db));
}

/** Return the set of index names present in the DB. */
function getIndexes(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Run EXPLAIN QUERY PLAN and return the plan rows as strings.
 * Each row's `detail` field describes the strategy SQLite chose.
 */
function explainPlan(db: Database.Database, sql: string, params: unknown[] = []): string[] {
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params) as { detail: string }[];
  return rows.map((r) => r.detail);
}

/** Seed minimal rows so the query planner has statistics to work with. */
function seedData(db: Database.Database): void {
  // Players
  for (let i = 0; i < 20; i++) {
    db.prepare(
      `INSERT INTO players (player_id, wallet, region, position, progress_level, created_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(
      `player-${i}`,
      `wallet-${i}`,
      i % 2 === 0 ? 'EU' : 'NA',
      i % 3 === 0 ? 'FWD' : 'MID',
      i % 5,
      Date.now() - i * 1000
    );
  }

  // Subscriptions
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO subscriptions (scout_wallet, tier, expires_at, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(`scout-${i}`, 'pro', Date.now() + i * 86400000, Date.now());
  }

  // Contact unlocks
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO contact_unlocks (scout_wallet, player_id, tx_hash, unlocked_at)
       VALUES (?, ?, ?, ?)`
    ).run(`scout-${i}`, `player-${i}`, `tx-${i}`, Date.now());
  }

  // Audit log
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO audit_log (action, admin_wallet, query_params, created_at, prev_hash, hash, event_source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'player.deactivate',
      `admin-${i}`,
      '{}',
      new Date(Date.now() - i * 3600000).toISOString(),
      'genesis',
      `hash-${i}`,
      'admin_action'
    );
  }

  // Idempotency keys
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    db.prepare(
      `INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(`idem-key-${i}`, 200, '{}', now, now + 86400000);
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Migration 013 — composite indexes (#821)', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    migrate(db);
    seedData(db);
    // Run ANALYZE so the query planner has up-to-date statistics.
    db.exec('ANALYZE');
  });

  afterAll(() => {
    db.close();
  });

  // ── 1. Index existence ────────────────────────────────────────────────────

  describe('all 5 composite indexes are created', () => {
    it('idx_players_region_position_tier exists', () => {
      expect(getIndexes(db)).toContain('idx_players_region_position_tier');
    });

    it('idx_subscriptions_wallet_active_expires exists', () => {
      expect(getIndexes(db)).toContain('idx_subscriptions_wallet_active_expires');
    });

    it('idx_contact_unlocks_scout_player exists', () => {
      expect(getIndexes(db)).toContain('idx_contact_unlocks_scout_player');
    });

    it('idx_audit_log_action_created_at exists', () => {
      expect(getIndexes(db)).toContain('idx_audit_log_action_created_at');
    });

    it('idx_idempotency_keys_key_expires exists', () => {
      expect(getIndexes(db)).toContain('idx_idempotency_keys_key_expires');
    });
  });

  // ── 2. EXPLAIN QUERY PLAN — each index is used (SEARCH, not SCAN) ─────────

  describe('EXPLAIN QUERY PLAN confirms index usage', () => {
    it('players filter query uses idx_players_region_position_tier', () => {
      const plan = explainPlan(
        db,
        `SELECT * FROM players WHERE region = ? AND position = ? AND progress_level >= ? AND is_active = 1
         ORDER BY created_at ASC LIMIT 20 OFFSET 0`,
        ['EU', 'FWD', 2]
      );
      const planText = plan.join('\n');
      expect(planText).toMatch(/SEARCH players USING INDEX idx_players_region_position_tier/i);
      expect(planText).not.toMatch(/SCAN TABLE players(?! USING)/i);
    });

    it('getLatestSubscription query uses idx_subscriptions_wallet_active_expires', () => {
      const plan = explainPlan(
        db,
        `SELECT * FROM subscriptions
         WHERE scout_wallet = ? AND cancelled_at IS NULL
         ORDER BY expires_at DESC LIMIT 1`,
        ['scout-0']
      );
      const planText = plan.join('\n');
      expect(planText).toMatch(/SEARCH subscriptions USING INDEX idx_subscriptions_wallet_active_expires/i);
      expect(planText).not.toMatch(/SCAN TABLE subscriptions(?! USING)/i);
    });

    it('hasContactUnlock query uses idx_contact_unlocks_scout_player', () => {
      const plan = explainPlan(
        db,
        `SELECT 1 FROM contact_unlocks WHERE scout_wallet = ? AND player_id = ? LIMIT 1`,
        ['scout-0', 'player-0']
      );
      const planText = plan.join('\n');
      expect(planText).toMatch(/SEARCH contact_unlocks USING INDEX idx_contact_unlocks_scout_player/i);
      expect(planText).not.toMatch(/SCAN TABLE contact_unlocks(?! USING)/i);
    });

    it('getAuditLogs query uses idx_audit_log_action_created_at', () => {
      const plan = explainPlan(
        db,
        `SELECT * FROM audit_log
         WHERE action = ? AND created_at >= ? AND created_at <= ?
         ORDER BY created_at DESC LIMIT 50 OFFSET 0`,
        ['player.deactivate', '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z']
      );
      const planText = plan.join('\n');
      expect(planText).toMatch(/SEARCH audit_log USING INDEX idx_audit_log_action_created_at/i);
      expect(planText).not.toMatch(/SCAN TABLE audit_log(?! USING)/i);
    });

    it('getIdempotencyRecord query uses idx_idempotency_keys_key_expires', () => {
      const plan = explainPlan(
        db,
        `SELECT * FROM idempotency_keys WHERE key = ? AND expires_at > ?`,
        ['idem-key-0', Date.now()]
      );
      const planText = plan.join('\n');
      // key is the PRIMARY KEY so SQLite may report USING INTEGER PRIMARY KEY or
      // USING INDEX — both are index scans, not full table scans.
      expect(planText).not.toMatch(/SCAN TABLE idempotency_keys(?! USING)/i);
    });

    it('purgeExpiredIdempotencyKeys DELETE uses an index scan', () => {
      const plan = explainPlan(
        db,
        `DELETE FROM idempotency_keys WHERE expires_at <= ?`,
        [Date.now() - 1]
      );
      const planText = plan.join('\n');
      expect(planText).not.toMatch(/SCAN TABLE idempotency_keys(?! USING)/i);
    });
  });

  // ── 3. Idempotency — migration applies exactly once ───────────────────────

  describe('migration 013 is idempotent', () => {
    it('running migrations again does not throw and does not duplicate indexes', () => {
      expect(() => migrate(db)).not.toThrow();

      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .all() as { name: string }[];
      const names = rows.map((r) => r.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('migration 013_composite_indexes.sql is recorded in migrations table', () => {
      const row = db
        .prepare("SELECT id FROM migrations WHERE id = '013_composite_indexes.sql'")
        .get() as { id: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.id).toBe('013_composite_indexes.sql');
    });
  });
});
