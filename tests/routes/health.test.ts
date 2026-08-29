/**
 * Tests for the readiness probe endpoints (/ready and /health/readiness).
 * Both delegates to the shared checkReadiness() helper, so they must return
 * identical responses for the same service states.
 */

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  checkHealth: jest.fn(),
}));

// Partially mock the db module so individual tests can control getDriver() —
// src/app.ts's /health and /ready probes go through the DbDriver, not the raw
// getDb() handle, so they work identically under DB_DRIVER=sqlite and
// DB_DRIVER=postgres.
jest.mock('../../src/db', () => {
  const actual = jest.requireActual<typeof import('../../src/db')>('../../src/db');
  return { ...actual, getDriver: jest.fn(actual.getDriver) };
});

import request from 'supertest';
import app from '../../src/app';
import * as ipfsService from '../../src/services/ipfs';
import * as dbModule from '../../src/db';

const mockCheckHealth = ipfsService.checkHealth as jest.Mock;
const mockGetDriver = dbModule.getDriver as jest.Mock;
// getDriver() throws until initDb() has run (tests/setup.ts's beforeAll), so
// this can't be resolved at module-import time — read it lazily instead.
function getRealDriver() {
  return jest.requireActual<typeof import('../../src/db')>('../../src/db').getDriver();
}

/**
 * Build a driver-shaped object that delegates every method to the real
 * driver except the ones named in `overrides`. A plain object spread
 * (`{ ...getRealDriver() }`) does NOT work here — SqliteDriver's methods are
 * defined on its class prototype, not as the instance's own enumerable
 * properties, so a spread silently drops them all.
 */
function driverWith(overrides: Partial<ReturnType<typeof getRealDriver>>) {
  const real = getRealDriver();
  return {
    all: real.all.bind(real),
    get: real.get.bind(real),
    value: real.value.bind(real),
    run: real.run.bind(real),
    exec: real.exec.bind(real),
    transaction: real.transaction.bind(real),
    close: real.close.bind(real),
    ...overrides,
  };
}

// ─── /ready ──────────────────────────────────────────────────────────────────

const READINESS_PATHS = ['/ready', '/health/readiness'];

describe.each(READINESS_PATHS)('%s', (path) => {
  afterEach(() => {
    mockCheckHealth.mockReset();
    mockGetDriver.mockReset();
    // Restore to the real implementation between tests
    mockGetDriver.mockImplementation(getRealDriver);
  });

  it('returns 200 and includes db:ok when all dependencies are healthy', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.services.ipfs).toBe('ok');
    expect(res.body.services.db).toBe('ok');
  });

  it('includes db field in the services object', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const res = await request(app).get('/ready');
    expect(res.body.services).toHaveProperty('db');
    expect(['ok', 'unavailable']).toContain(res.body.services.db);
  });

  it('returns 503 with ipfs:unavailable when IPFS is unreachable', async () => {
    mockCheckHealth.mockRejectedValueOnce(new Error('IPFS connection refused'));
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.services.ipfs).toBe('unavailable');
  });

  it('returns 503 with db:unavailable when the database probe throws', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    // Simulate a locked or corrupted DB. /ready's readiness probe
    // (probeDbWritable in src/app.ts) checks writability via driver.run(),
    // not driver.get() — unlike /health's liveness probe.
    mockGetDriver.mockImplementation(() =>
      driverWith({ run: () => Promise.reject(new Error('SQLITE_BUSY: database is locked')) }),
    );
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.services.db).toBe('unavailable');
  });

  it('returns 503 with db:unavailable when the DB is read-only (writes fail, reads still succeed)', async () => {
    mockCheckHealth.mockResolvedValueOnce(undefined);
    const real = getRealDriver();
    mockGetDriver.mockImplementation(() =>
      driverWith({
        run: (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO indexer_state')) {
            return Promise.reject(new Error('SQLITE_READONLY: attempt to write a readonly database'));
          }
          return real.run(sql, params);
        },
      }),
    );
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.services.db).toBe('unavailable');
  });
});

// ─── /health ─────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  afterEach(() => {
    mockGetDriver.mockReset();
    mockGetDriver.mockImplementation(getRealDriver);
  });

  it('returns 200 and includes db field in healthStatus', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.healthStatus).toHaveProperty('db');
    expect(['ok', 'error']).toContain(res.body.healthStatus.db);
  });

  it('includes db:ok when the database is reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.body.healthStatus.db).toBe('ok');
  });

  it('reports db:error in healthStatus but still returns 200 when the DB probe fails', async () => {
    // /health is a liveness probe — it always returns 200.
    // A DB failure is surfaced in healthStatus.db without changing the HTTP status.
    mockGetDriver.mockImplementation(() =>
      driverWith({ get: () => Promise.reject(new Error('SQLITE_BUSY: database is locked')) }),
    );
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.healthStatus.db).toBe('error');
  });
});

describe('GET /ready and GET /health/readiness return identical responses', () => {
  it('both return ok when IPFS is healthy', async () => {
    mockCheckHealth.mockResolvedValue(undefined);
    const [a, b] = await Promise.all([
      request(app).get('/ready'),
      request(app).get('/health/readiness'),
    ]);
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  it('both return degraded when IPFS is down', async () => {
    mockCheckHealth.mockRejectedValue(new Error('down'));
    const [a, b] = await Promise.all([
      request(app).get('/ready'),
      request(app).get('/health/readiness'),
    ]);
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});
