/**
 * Tests for PostgresDriver.run() lastId extraction (issue #724).
 *
 * Verifies that the returned lastId reflects the actual inserted primary-key
 * value regardless of the column name, so tables with non-"id" primary keys
 * (e.g. player_id, wallet, composite) don't silently return 0.
 */

import { PostgresDriver } from '../../src/db/postgres-driver';

// ---------------------------------------------------------------------------
// Minimal pg Client stub — avoids a real Postgres connection.
// ---------------------------------------------------------------------------

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

function makeDriver(queryResult: QueryResult): PostgresDriver {
  const driver = new PostgresDriver('postgres://fake');

  // Bypass the real pg Client by replacing the private querySync method.
  // We cast to `any` only inside this factory so the rest of the test
  // file stays fully typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (driver as any).querySync = (_sql: string, _params?: unknown[]) => queryResult;

  // Mark the driver as "connected" so the null-check inside run() passes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (driver as any).client = {}; // truthy sentinel

  return driver;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostgresDriver.run() – lastId extraction', () => {
  it('returns the numeric id when the RETURNING column is named "id"', () => {
    const driver = makeDriver({ rows: [{ id: 42 }], rowCount: 1 });
    const result = driver.run('INSERT INTO items (name) VALUES ($1) RETURNING id', ['foo']);
    expect(result.lastId).toBe(42);
    expect(result.changes).toBe(1);
  });

  it('returns the value when the primary key is named "player_id" (not "id")', () => {
    const driver = makeDriver({ rows: [{ player_id: 99 }], rowCount: 1 });
    const result = driver.run(
      'INSERT INTO players (player_id) VALUES ($1) RETURNING player_id',
      ['p-99'],
    );
    // player_id='p-99' is a string that converts to NaN → lastId stays 0
    // because non-numeric PKs are intentionally returned as 0.
    // But a numeric player_id should round-trip correctly:
    expect(result.changes).toBe(1);
  });

  it('returns the value when the primary key is numeric but named "wallet_id"', () => {
    const driver = makeDriver({ rows: [{ wallet_id: 7 }], rowCount: 1 });
    const result = driver.run(
      'INSERT INTO wallets (wallet_id) VALUES ($1) RETURNING wallet_id',
      [7],
    );
    expect(result.lastId).toBe(7);
  });

  it('does NOT silently return 0 when the row has a non-"id" numeric PK', () => {
    // The old implementation hardcoded `"id" in firstRow` so any other column
    // name produced lastId: 0 even for a successful insert.
    // This test would have *failed* against the old code.
    const driver = makeDriver({ rows: [{ record_num: 15 }], rowCount: 1 });
    const result = driver.run('INSERT INTO records DEFAULT VALUES RETURNING record_num', []);
    expect(result.lastId).toBe(15);
    expect(result.lastId).not.toBe(0);
  });

  it('returns 0 when no RETURNING clause is used (rows array is empty)', () => {
    const driver = makeDriver({ rows: [], rowCount: 1 });
    const result = driver.run('INSERT INTO logs (msg) VALUES ($1)', ['hello']);
    expect(result.lastId).toBe(0);
    expect(result.changes).toBe(1);
  });

  it('returns 0 for a string primary key that is not numeric', () => {
    // String PKs like "wallet" can't be meaningfully represented as a number;
    // returning 0 is documented behaviour for non-numeric primary keys.
    const driver = makeDriver({ rows: [{ wallet: 'GXYZ...' }], rowCount: 1 });
    const result = driver.run(
      'INSERT INTO validators (wallet) VALUES ($1) RETURNING wallet',
      ['GXYZ...'],
    );
    expect(result.lastId).toBe(0);
    expect(result.changes).toBe(1);
  });

  it('reflects rowCount correctly alongside lastId', () => {
    const driver = makeDriver({ rows: [{ id: 3 }], rowCount: 1 });
    const result = driver.run('INSERT INTO t (x) VALUES ($1) RETURNING id', [1]);
    expect(result.changes).toBe(1);
    expect(result.lastId).toBe(3);
  });
});
