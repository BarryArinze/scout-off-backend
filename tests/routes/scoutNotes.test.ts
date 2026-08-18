/**
 * Tests for private scout notes (#488)
 *
 * Verifies:
 *  - Scouts can create, update, and read private notes on players
 *  - Notes are private per-scout (cross-scout reads are denied)
 *  - Players and validators cannot read another scout's notes
 *  - Upserting twice updates in place
 *  - Notes do NOT leak through admin events / export endpoints
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  // existing mocks required by scout router
  queryEvents: jest.fn(),
  getPlayerById: jest.fn(),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  // notes helpers
  upsertScoutNote: jest.fn(),
  getScoutNote: jest.fn(),
  getScoutNotes: jest.fn(),
  // api key helpers (needed by scout router import)
  insertApiKey: jest.fn(),
  listApiKeysByWallet: jest.fn().mockReturnValue([]),
  revokeApiKeyById: jest.fn(),
  getApiKeyByHash: jest.fn().mockReturnValue(null),
  touchApiKeyLastUsed: jest.fn().mockResolvedValue(undefined),
  // bookmarks helpers (needed by scout router import)
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
  upsertScoutNote,
  getScoutNote,
  getScoutNotes,
} from '../../src/db';

const mockUpsertScoutNote = upsertScoutNote as jest.Mock;
const mockGetScoutNote = getScoutNote as jest.Mock;
const mockGetScoutNotes = getScoutNotes as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCOUT_A = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';
const SCOUT_B = 'GAEZS7NMWCNTUFGDNXWVYVTKGGP47CESPEV5BVT5LNFHKXC5TGBZ4O5O';
const PLAYER  = 'GBXDL7VCREKVMQWV3ZL4BK3OFZZUVRKUTPHKCDPUMOVMCUFLZGKQMXWY';
const PLAYER_ID = 'player-abc-123';

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const scoutAToken = makeToken(SCOUT_A);
const scoutBToken = makeToken(SCOUT_B);
const playerToken = makeToken(PLAYER, 'player');
const validatorToken = makeToken(PLAYER, 'validator');

// ─── PUT /api/scouts/:wallet/notes/:playerId ──────────────────────────────────

describe('PUT /api/scouts/:wallet/notes/:playerId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a note and returns 200', async () => {
    mockUpsertScoutNote.mockReturnValueOnce(undefined);

    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: 'Good pace, strong left foot' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.note).toBe('Good pace, strong left foot');
    expect(res.body.data.player_id).toBe(PLAYER_ID);
    expect(mockUpsertScoutNote).toHaveBeenCalledTimes(1);
  });

  it('upserts (updates in place) when called twice for same player', async () => {
    mockUpsertScoutNote.mockReturnValue(undefined);

    await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: 'First impression' });

    await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: 'Updated impression after second viewing' });

    // Both calls must reach the upsert helper (deduplication is handled by SQL)
    expect(mockUpsertScoutNote).toHaveBeenCalledTimes(2);
  });

  it('sanitizes note text before storing', async () => {
    mockUpsertScoutNote.mockReturnValueOnce(undefined);

    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: 'Fast player\x00\x1f' }); // control chars stripped by sanitizer

    expect(res.status).toBe(200);
    expect(res.body.data.note).not.toContain('\x00');
  });

  it('returns 403 when scout tries to write to a different wallet', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_B}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: 'Should not be allowed' });

    expect(res.status).toBe(403);
    expect(mockUpsertScoutNote).not.toHaveBeenCalled();
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .send({ note: 'No auth' });

    expect(res.status).toBe(401);
  });

  it('returns 403 when a player token is used', async () => {
    const res = await request(app)
      .put(`/api/scouts/${PLAYER}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ note: 'Player trying to set scout note' });

    expect(res.status).toBe(403);
  });

  it('returns 400 when note is empty', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({ note: '' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when note field is missing', async () => {
    const res = await request(app)
      .put(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/scouts/:wallet/notes/:playerId ──────────────────────────────────

describe('GET /api/scouts/:wallet/notes/:playerId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the note for the authoring scout', async () => {
    mockGetScoutNote.mockReturnValueOnce({
      id: 1,
      scout_wallet: SCOUT_A,
      player_id: PLAYER_ID,
      note_text: 'Strong defender',
      updated_at: 1_700_000_000,
    });

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.note).toBe('Strong defender');
  });

  it('returns 404 when no note exists', async () => {
    mockGetScoutNote.mockReturnValueOnce(null);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 when scout B tries to read scout A notes', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockGetScoutNote).not.toHaveBeenCalled();
  });

  it('returns 403 when a player token is used', async () => {
    const res = await request(app)
      .get(`/api/scouts/${PLAYER}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(res.status).toBe(403);
  });

  it('returns 403 when a validator token is used', async () => {
    const res = await request(app)
      .get(`/api/scouts/${PLAYER}/notes/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${validatorToken}`);

    expect(res.status).toBe(403);
  });

  it('returns 401 when no token provided', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes/${PLAYER_ID}`);

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/scouts/:wallet/notes ───────────────────────────────────────────

describe('GET /api/scouts/:wallet/notes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all notes for the authoring scout', async () => {
    mockGetScoutNotes.mockReturnValueOnce([
      { id: 1, scout_wallet: SCOUT_A, player_id: 'p1', note_text: 'Fast', updated_at: 2 },
      { id: 2, scout_wallet: SCOUT_A, player_id: 'p2', note_text: 'Tall', updated_at: 1 },
    ]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].note).toBe('Fast');
  });

  it('returns empty array when scout has no notes', async () => {
    mockGetScoutNotes.mockReturnValueOnce([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 403 when scout B tries to list scout A notes', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockGetScoutNotes).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/notes`);

    expect(res.status).toBe(401);
  });
});

// ─── Notes must not leak through admin endpoints ──────────────────────────────

describe('Admin endpoints must not expose scout notes', () => {
  const ADMIN_TOKEN = jwt.sign(
    { sub: 'GADMIN', role: 'admin' },
    SECRET,
    { expiresIn: '1h' },
  );

  it('GET /api/admin/events does not contain scout_player_notes data', async () => {
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    // The response body should never reference note_text or scout_player_notes
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain('note_text');
    expect(bodyStr).not.toContain('scout_player_notes');
  });

  it('GET /api/admin/events/export does not contain scout note data', async () => {
    const res = await request(app)
      .get('/api/admin/events/export')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);

    const bodyStr = typeof res.text === 'string' ? res.text : JSON.stringify(res.body);
    expect(bodyStr).not.toContain('note_text');
    expect(bodyStr).not.toContain('scout_player_notes');
  });
});
