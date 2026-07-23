/**
 * Tests for PostgresDriver SSL configuration (#721).
 *
 * Verifies that the ssl option is correctly passed to the underlying pg.Client
 * constructor for each value of DATABASE_SSL / the PostgresSslOption type.
 *
 * The pg.Client itself is mocked so no real database connection is required.
 */

// ─── Mock pg ─────────────────────────────────────────────────────────────────

const mockClientConstructor = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);

jest.mock('pg', () => {
  // Capture the ClientConfig passed to the constructor so we can inspect it.
  return {
    Client: jest.fn().mockImplementation((config: object) => {
      mockClientConstructor(config);
      return {
        connect: mockConnect,
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        end: jest.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

import { PostgresDriver, type PostgresSslOption } from '../../src/db/postgres-driver';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function capturedClientConfig(): Record<string, unknown> {
  expect(mockClientConstructor).toHaveBeenCalled();
  return mockClientConstructor.mock.calls[mockClientConstructor.mock.calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  mockClientConstructor.mockClear();
  mockConnect.mockClear();
});

// ─── SSL option: false (default) ─────────────────────────────────────────────

describe('ssl: false (no TLS)', () => {
  it('does not set an ssl property on the client config when ssl=false', () => {
    new PostgresDriver('postgresql://localhost/test', false);
    const config = capturedClientConfig();
    expect(config).not.toHaveProperty('ssl');
  });

  it('does not set an ssl property when ssl is omitted (default)', () => {
    new PostgresDriver('postgresql://localhost/test');
    const config = capturedClientConfig();
    expect(config).not.toHaveProperty('ssl');
  });

  it('passes the connectionString through regardless of ssl option', () => {
    const url = 'postgresql://user:pass@db.example.com:5432/mydb';
    new PostgresDriver(url, false);
    const config = capturedClientConfig();
    expect(config.connectionString).toBe(url);
  });
});

// ─── SSL option: true (full verification) ────────────────────────────────────

describe('ssl: true (full certificate verification)', () => {
  it('sets ssl.rejectUnauthorized=true when ssl=true', () => {
    new PostgresDriver('postgresql://localhost/test', true);
    const config = capturedClientConfig();
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('does not disable certificate verification when ssl=true', () => {
    new PostgresDriver('postgresql://localhost/test', true);
    const config = capturedClientConfig();
    const ssl = config.ssl as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).toBe(true);
  });
});

// ─── SSL option: 'no-verify' (skip cert verification) ────────────────────────

describe('ssl: no-verify (transport only, no cert check)', () => {
  it('sets ssl.rejectUnauthorized=false when ssl="no-verify"', () => {
    new PostgresDriver('postgresql://localhost/test', 'no-verify');
    const config = capturedClientConfig();
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('has ssl property present (TLS transport enabled) when ssl="no-verify"', () => {
    new PostgresDriver('postgresql://localhost/test', 'no-verify');
    const config = capturedClientConfig();
    expect(config).toHaveProperty('ssl');
  });
});

// ─── Contrast: true vs no-verify ─────────────────────────────────────────────

describe('ssl option contrast', () => {
  it('ssl=true and ssl="no-verify" both enable TLS but differ in cert verification', () => {
    new PostgresDriver('postgresql://localhost/test', true);
    const fullVerify = capturedClientConfig().ssl as Record<string, unknown>;
    mockClientConstructor.mockClear();

    new PostgresDriver('postgresql://localhost/test', 'no-verify');
    const noVerify = capturedClientConfig().ssl as Record<string, unknown>;

    expect(fullVerify.rejectUnauthorized).toBe(true);
    expect(noVerify.rejectUnauthorized).toBe(false);
  });
});

// ─── Type safety: all valid PostgresSslOption values compile and behave correctly ──

describe('valid PostgresSslOption values', () => {
  const options: PostgresSslOption[] = [true, false, 'no-verify'];

  it.each(options)('constructs without throwing for ssl=%p', (ssl) => {
    expect(() => new PostgresDriver('postgresql://localhost/test', ssl)).not.toThrow();
  });
});
