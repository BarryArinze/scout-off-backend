/**
 * Tests for API key issuance and rotation (#490)
 *
 * Verifies:
 *  - Scouts can issue, list, and revoke API keys
 *  - Only a salted hash is persisted (plaintext returned once at issuance)
 *  - auth.ts accepts X-API-Key header for authenticated requests
 *  - Revoked/unknown keys are rejected
 *  - Cross-wallet operations are denied
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import { generateApiKey, verifyApiKey, resolveApiKey } from '../../src/controllers/apiKeyController';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  // shared scout router dependencies
  queryEvents: jest.fn(),
  getPlayerById: jest.fn(),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  // notes
  upsertScoutNote: jest.fn(),
  getScoutNote: jest.fn(),
  getScoutNotes: jest.fn().mockReturnValue([]),
  // api keys
  insertApiKey: jest.fn(),
  listApiKeysByWallet: jest.fn().mockReturnValue([]),
  revokeApiKeyById: jest.fn(),
  getApiKeyByHash: jest.fn().mockReturnValue(null),
  getAllActiveApiKeys: jest.fn().mockReturnValue([]),
  touchApiKeyLastUsed: jest.fn(),
  // bookmarks
  insertBookmark: jest.fn(),
  deleteBookmark: jest.fn(),
  getBookmarksByScout: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  submitContactPayment: jest.fn(),
  purchaseSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
  insertTrialOffer: jest.fn(),
  getTrialOffers: jest.fn().mockReturnValue([]),
}));

import {
  insertApiKey,
  listApiKeysByWallet,
  revokeApiKeyById,
  getAllActiveApiKeys,
  touchApiKeyLastUsed,
} from '../../src/db';

const mockInsertApiKey    = insertApiKey    as jest.Mock;
const mockListApiKeys     = listApiKeysByWallet as jest.Mock;
const mockRevokeApiKey    = revokeApiKeyById as jest.Mock;
const mockGetAllActive    = getAllActiveApiKeys as jest.Mock;
const mockTouchLastUsed   = touchApiKeyLastUsed as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCOUT_A = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';
const SCOUT_B = 'GAEZS7NMWCNTUFGDNXWVYVTKGGP47CESPEV5BVT5LNFHKXC5TGBZ4O5O';

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const scoutAToken = makeToken(SCOUT_A);
const scoutBToken = makeToken(SCOUT_B);

// ─── Unit tests for crypto helpers ────────────────────────────────────────────

describe('generateApiKey / verifyApiKey (unit)', () => {
  it('generates a 64-char hex key', () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates a different key each call', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it('verifyApiKey returns true for matching raw key', () => {
    const { key, keyHash } = generateApiKey();
    expect(verifyApiKey(key, keyHash)).toBe(true);
  });

  it('verifyApiKey returns false for wrong key', () => {
    const { keyHash } = generateApiKey();
    expect(verifyApiKey('completely-wrong-key', keyHash)).toBe(false);
  });

  it('verifyApiKey returns false for tampered hash', () => {
    const { key, keyHash } = generateApiKey();
    const tampered = keyHash.slice(0, -4) + 'aaaa';
    expect(verifyApiKey(key, tampered)).toBe(false);
  });

  it('verifyApiKey returns false for malformed hash (no separator)', () => {
    expect(verifyApiKey('anykey', 'nocolon')).toBe(false);
  });

  it('never stores plaintext — keyHash does not contain the raw key', () => {
    const { key, keyHash } = generateApiKey();
    expect(keyHash).not.toContain(key);
  });
});

describe('resolveApiKey (unit)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when getAllActiveApiKeys returns empty array', () => {
    mockGetAllActive.mockReturnValueOnce([]);
    expect(resolveApiKey('somekey')).toBeNull();
  });

  it('returns scout_wallet and id when key matches', () => {
    const { key, keyHash } = generateApiKey();
    mockGetAllActive.mockReturnValueOnce([
      { id: 42, key_hash: keyHash, scout_wallet: SCOUT_A, label: 'test', created_at: 0, last_used_at: null, revoked_at: null },
    ]);
    const result = resolveApiKey(key);
    expect(result).toEqual({ scout_wallet: SCOUT_A, id: 42 });
  });

  it('returns null when no key matches', () => {
    const { keyHash } = generateApiKey();
    mockGetAllActive.mockReturnValueOnce([
      { id: 1, key_hash: keyHash, scout_wallet: SCOUT_A, label: '', created_at: 0, last_used_at: null, revoked_at: null },
    ]);
    expect(resolveApiKey('completely-different-key')).toBeNull();
  });
});

// ─── POST /api/scouts/:wallet/api-keys ───────────────────────────────────────

describe('POST /api/scouts/:wallet/api-keys', () => {
  beforeEach(() => jest.clearAllMocks());

  it('issues a key and returns 201 with plaintext key', async () => {
    mockInsertApiKey.mockReturnValueOnce(7);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ label: 'CI pipeline' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(7);
    expect(res.body.data.label).toBe('CI pipeline');
    // plaintext key must be a 64-char hex string
    expect(res.body.data.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('only persists hash (insertApiKey is called with key_hash not plaintext)', async () => {
    mockInsertApiKey.mockReturnValueOnce(1);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ label: 'server' });

    expect(res.status).toBe(201);
    const plaintextKey = res.body.data.key;
    const callArg = mockInsertApiKey.mock.calls[0][0];
    // key_hash must NOT equal or contain the plaintext key
    expect(callArg.key_hash).not.toBe(plaintextKey);
    expect(callArg.key_hash).not.toContain(plaintextKey);
    // key_hash must be in salt:hash format
    expect(callArg.key_hash).toContain(':');
  });

  it('returns 403 when scout writes to a different wallet', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_B}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ label: 'bad' });

    expect(res.status).toBe(403);
    expect(mockInsertApiKey).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .send({ label: 'nope' });

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-scout role', async () => {
    const playerToken = makeToken(SCOUT_A, 'player');
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ label: 'bad' });

    expect(res.status).toBe(403);
  });
});

// ─── GET /api/scouts/:wallet/api-keys ────────────────────────────────────────

describe('GET /api/scouts/:wallet/api-keys', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists keys without exposing plaintext or full hash', async () => {
    const { keyHash } = generateApiKey();
    mockListApiKeys.mockReturnValueOnce([
      { id: 1, key_hash: keyHash, scout_wallet: SCOUT_A, label: 'bot', created_at: 1000, last_used_at: null, revoked_at: null },
    ]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const item = res.body.data[0];
    // Must not expose full hash
    expect(item.key_hash).toBeUndefined();
    // Must provide a shortened display hint
    expect(item.key_prefix).toMatch(/…$/);
    expect(item.key_prefix.length).toBeLessThan(20);
  });

  it('returns 403 for cross-wallet access', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
  });
});

// ─── DELETE /api/scouts/:wallet/api-keys/:id ─────────────────────────────────

describe('DELETE /api/scouts/:wallet/api-keys/:id', () => {
  beforeEach(() => jest.clearAllMocks());

  it('revokes a key and returns 200', async () => {
    mockRevokeApiKey.mockReturnValueOnce(true);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/api-keys/3`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBe(true);
    expect(mockRevokeApiKey).toHaveBeenCalledWith(3, SCOUT_A);
  });

  it('returns 404 when key not found', async () => {
    mockRevokeApiKey.mockReturnValueOnce(false);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/api-keys/999`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 for cross-wallet revocation', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/api-keys/3`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockRevokeApiKey).not.toHaveBeenCalled();
  });
});

// ─── X-API-Key authentication ─────────────────────────────────────────────────

describe('X-API-Key header authentication', () => {
  beforeEach(() => jest.clearAllMocks());

  it('accepts a valid X-API-Key for an authenticated request', async () => {
    const { key, keyHash } = generateApiKey();
    mockGetAllActive.mockReturnValue([
      { id: 5, key_hash: keyHash, scout_wallet: SCOUT_A, label: '', created_at: 0, last_used_at: null, revoked_at: null },
    ]);
    mockListApiKeys.mockReturnValue([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('X-API-Key', key);

    expect(res.status).toBe(200);
    expect(mockTouchLastUsed).toHaveBeenCalledWith(5);
  });

  it('updates last_used_at when an API key is used', async () => {
    const { key, keyHash } = generateApiKey();
    mockGetAllActive.mockReturnValue([
      { id: 9, key_hash: keyHash, scout_wallet: SCOUT_A, label: '', created_at: 0, last_used_at: null, revoked_at: null },
    ]);
    mockListApiKeys.mockReturnValue([]);

    await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('X-API-Key', key);

    expect(mockTouchLastUsed).toHaveBeenCalledWith(9);
  });

  it('rejects an unknown API key with 401', async () => {
    mockGetAllActive.mockReturnValue([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('X-API-Key', 'unknown-key-that-does-not-exist');

    expect(res.status).toBe(401);
  });

  it('rejects a revoked key (revoked_at is non-null = excluded by getAllActiveApiKeys)', async () => {
    // getAllActiveApiKeys returns only non-revoked rows, so revoked key cannot be found
    mockGetAllActive.mockReturnValue([]); // simulates revoked key filtered out

    const { key } = generateApiKey();
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/api-keys`)
      .set('X-API-Key', key);

    expect(res.status).toBe(401);
  });
});
