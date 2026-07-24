/**
 * Tests for the core backfill logic used by scripts/backfill.js
 * and the INDEXER_BACKFILL_FROM_LEDGER guard in src/index.ts.
 *
 * Exercises initDb → fetchLastIndexedLedger → persistLastIndexedLedger round-trip,
 * normal backfill-to-earlier-ledger, and the already-past-target
 * edge case where the reset should be a no-op.
 */

import { fetchLastIndexedLedger, persistLastIndexedLedger, getDb } from '../../src/db';

describe('backfill core logic (scripts/backfill.js)', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM indexer_state').run();
  });

  it('fetchLastIndexedLedger returns 0 when no state exists', () => {
    expect(fetchLastIndexedLedger()).toBe(0);
  });

  it('persistLastIndexedLedger / fetchLastIndexedLedger round-trips correctly', () => {
    persistLastIndexedLedger(5_000_000);
    expect(fetchLastIndexedLedger()).toBe(5_000_000);
  });

  it('resets last_ledger to an earlier value (normal backfill)', () => {
    persistLastIndexedLedger(10_000_000);
    expect(fetchLastIndexedLedger()).toBe(10_000_000);

    persistLastIndexedLedger(8_000_000);
    expect(fetchLastIndexedLedger()).toBe(8_000_000);
  });

  it('overwrites last_ledger with a higher value (unconditional set)', () => {
    persistLastIndexedLedger(1_000_000);
    expect(fetchLastIndexedLedger()).toBe(1_000_000);

    persistLastIndexedLedger(9_000_000);
    expect(fetchLastIndexedLedger()).toBe(9_000_000);
  });

  it('is idempotent — setting the same ledger twice is safe', () => {
    persistLastIndexedLedger(3_000_000);
    persistLastIndexedLedger(3_000_000);
    expect(fetchLastIndexedLedger()).toBe(3_000_000);
  });
});

describe('INDEXER_BACKFILL_FROM_LEDGER guard (src/index.ts)', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM indexer_state').run();
  });

  /**
   * Mirrors the guard logic from src/index.ts:
   *
   *   if (config.backfillFromLedger !== null) {
   *     const stored = fetchLastIndexedLedger();
   *     if (config.backfillFromLedger < stored) {
   *       persistLastIndexedLedger(config.backfillFromLedger);
   *     }
   *   }
   *
   * The guard only resets when the target is strictly less than the stored value.
   */

  function applyBackfillGuard(backfillFromLedger: number): boolean {
    const stored = fetchLastIndexedLedger();
    if (backfillFromLedger < stored) {
      persistLastIndexedLedger(backfillFromLedger);
      return true; // reset happened
    }
    return false; // no-op
  }

  it('resets last_ledger when target is earlier than stored', () => {
    persistLastIndexedLedger(10_000_000);

    const didReset = applyBackfillGuard(7_000_000);

    expect(didReset).toBe(true);
    expect(fetchLastIndexedLedger()).toBe(7_000_000);
  });

  it('is a no-op when target equals the stored value', () => {
    persistLastIndexedLedger(5_000_000);

    const didReset = applyBackfillGuard(5_000_000);

    expect(didReset).toBe(false);
    expect(fetchLastIndexedLedger()).toBe(5_000_000);
  });

  it('is a no-op when target is already past the current indexed point', () => {
    persistLastIndexedLedger(3_000_000);

    const didReset = applyBackfillGuard(9_000_000);

    expect(didReset).toBe(false);
    expect(fetchLastIndexedLedger()).toBe(3_000_000);
  });

  it('is a no-op when no prior state exists and target is positive', () => {
    // fetchLastIndexedLedger() returns 0 when indexer_state is empty
    const didReset = applyBackfillGuard(1_000_000);

    expect(didReset).toBe(false);
    expect(fetchLastIndexedLedger()).toBe(0);
  });

  it('resets when stored is 0 and target is also 0 (equal — no-op)', () => {
    const didReset = applyBackfillGuard(0);

    expect(didReset).toBe(false);
    expect(fetchLastIndexedLedger()).toBe(0);
  });
});
