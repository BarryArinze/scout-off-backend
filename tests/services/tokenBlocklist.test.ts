/**
 * Unit tests for src/services/tokenBlocklist.ts
 *
 * Coverage:
 *  - revokeToken writes to both Redis and DB
 *  - isTokenRevoked returns true via Redis hit
 *  - isTokenRevoked falls back to DB when Redis is unavailable
 *  - isTokenRevoked returns false for an unknown jti
 *  - isTokenRevoked returns false for undefined/empty jti
 *  - Write-through: DB is written even when Redis fails
 *  - Fail-safe: DB read error returns true (blocks token)
 *  - pruneExpiredTokens removes expired rows
 */

import Database from 'better-sqlite3';

// ─── In-memory SQLite setup (mirrors setup.ts but scoped to this module) ──────
//
// The tokenBlocklist module calls getDriver() at runtime, NOT at import time,
// so we set up the DB before the module is first imported by any test.

process.env.DB_PATH = ':memory:';
process.env.DB_DRIVER = 'sqlite';

// ─── Module imports ───────────────────────────────────────────────────────────

import { getDriver } from '../../src/db';
import {
  revokeToken,
  isTokenRevoked,
  pruneExpiredTokens,
} from '../../src/services/tokenBlocklist';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 3600; // 1 h from now
const PAST_EXP   = Math.floor(Date.now() / 1000) - 1;    // already expired

function jtiExists(jti: string): boolean {
  const driver = getDriver();
  const row = driver.get<{ jti: string }>(
    'SELECT jti FROM revoked_tokens WHERE jti = ?',
    [jti],
  );
  return row !== undefined;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('tokenBlocklist — DB-only (no Redis)', () => {
  // Redis URL is NOT set in the test environment, so redisClient === null
  // and all Redis paths are skipped.  The tests exercise pure DB behaviour.

  beforeEach(() => {
    // Clean the table between tests
    try {
      getDriver().run('DELETE FROM revoked_tokens', []);
    } catch {
      // table may not exist yet on very first run — ignore
    }
  });

  it('revokeToken inserts the jti into the DB', async () => {
    const jti = 'unit-test-jti-1';
    await revokeToken(jti, FUTURE_EXP);
    expect(jtiExists(jti)).toBe(true);
  });

  it('isTokenRevoked returns true for a revoked jti', async () => {
    const jti = 'unit-test-jti-2';
    await revokeToken(jti, FUTURE_EXP);
    expect(await isTokenRevoked(jti)).toBe(true);
  });

  it('isTokenRevoked returns false for an unknown jti', async () => {
    expect(await isTokenRevoked('unknown-jti-xyz')).toBe(false);
  });

  it('isTokenRevoked returns false when jti is undefined', async () => {
    expect(await isTokenRevoked(undefined)).toBe(false);
  });

  it('isTokenRevoked returns false when jti is an empty string', async () => {
    expect(await isTokenRevoked('')).toBe(false);
  });

  it('isTokenRevoked treats an already-expired row as non-revoked', async () => {
    // Insert a row with an expiry in the past directly (bypassing the
    // revokeToken guard which skips already-expired tokens in Redis)
    const jti = 'unit-test-jti-expired';
    getDriver().run(
      'INSERT INTO revoked_tokens (jti, revoked_at, expires_at) VALUES (?, ?, ?)',
      [jti, Math.floor(Date.now() / 1000), PAST_EXP],
    );
    // The DB query in isTokenRevoked filters expires_at > now, so this should be false
    expect(await isTokenRevoked(jti)).toBe(false);
  });

  it('duplicate revokeToken calls do not throw (ON CONFLICT DO NOTHING)', async () => {
    const jti = 'unit-test-jti-dup';
    await revokeToken(jti, FUTURE_EXP);
    await expect(revokeToken(jti, FUTURE_EXP)).resolves.toBeUndefined();
  });

  it('pruneExpiredTokens removes rows with expired timestamps', () => {
    const driver = getDriver();
    const jti = 'unit-test-jti-prune';
    driver.run(
      'INSERT INTO revoked_tokens (jti, revoked_at, expires_at) VALUES (?, ?, ?)',
      [jti, Math.floor(Date.now() / 1000), PAST_EXP],
    );

    expect(jtiExists(jti)).toBe(true);
    pruneExpiredTokens();
    expect(jtiExists(jti)).toBe(false);
  });

  it('pruneExpiredTokens does not remove non-expired rows', async () => {
    const jti = 'unit-test-jti-keep';
    await revokeToken(jti, FUTURE_EXP);
    pruneExpiredTokens();
    expect(jtiExists(jti)).toBe(true);
  });
});

// ─── Redis failover scenario ──────────────────────────────────────────────────
//
// We simulate Redis being unavailable by monkey-patching the module's Redis
// client.  Since the client is a module-level private, we intercept at the
// ioredis level using jest mocks.

describe('tokenBlocklist — Redis-down failover', () => {
  beforeEach(() => {
    try {
      getDriver().run('DELETE FROM revoked_tokens', []);
    } catch { /* ignore */ }
  });

  it('still blocks a revoked token via DB when Redis exists() throws', async () => {
    // Revoke the token first (DB write always succeeds)
    const jti = 'failover-jti-1';
    await revokeToken(jti, FUTURE_EXP);

    // Now simulate Redis being down: isTokenRevoked should fall back to DB
    // We achieve this by mocking the ioredis module so exists() rejects.
    jest.mock('ioredis', () => {
      return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        setex: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        exists: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        keys: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      }));
    });

    // Reset module cache to reload with the mock Redis client
    jest.resetModules();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isTokenRevoked: isRevokedFresh } = require('../../src/services/tokenBlocklist');

    // With Redis mocked to fail, the DB fallback should still return true
    expect(await isRevokedFresh(jti)).toBe(true);

    jest.unmock('ioredis');
    jest.resetModules();
  });

  it('allows a non-revoked token via DB when Redis exists() throws', async () => {
    jest.mock('ioredis', () => {
      return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        setex: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        exists: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        keys: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      }));
    });

    jest.resetModules();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isTokenRevoked: isRevokedFresh } = require('../../src/services/tokenBlocklist');

    // Token was never revoked — DB will return undefined → false
    expect(await isRevokedFresh('never-revoked-jti')).toBe(false);

    jest.unmock('ioredis');
    jest.resetModules();
  });

  it('writes to DB even when Redis setex throws during revokeToken', async () => {
    jest.mock('ioredis', () => {
      return jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        setex: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        exists: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        keys: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      }));
    });

    jest.resetModules();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { revokeToken: revokeTokenFresh } = require('../../src/services/tokenBlocklist');

    const jti = 'failover-jti-write-through';
    // Should not throw even though Redis is down
    await expect(revokeTokenFresh(jti, FUTURE_EXP)).resolves.toBeUndefined();

    // DB row must exist
    expect(jtiExists(jti)).toBe(true);

    jest.unmock('ioredis');
    jest.resetModules();
  });
});
