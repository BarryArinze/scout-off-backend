/**
 * Tests for scout bookmarks (#487)
 *
 * Verifies:
 *  - Scouts can bookmark, unbookmark, and list bookmarked players
 *  - Re-bookmarking is idempotent (no error, no duplicate)
 *  - Bookmarking a nonexistent player returns 404
 *  - Bookmark list returns full player profile summaries
 *  - Cross-scout authorization is denied
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  // shared scout router dependencies
  queryEvents: jest.fn(),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  dbRenewSubscription: jest.fn(),
  dbCancelSubscription: jest.fn(),
  insertContactUnlock: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  // player lookup (used by bookmarks controller)
  getPlayerById: jest.fn(),
  // notes
  upsertScoutNote: jest.fn(),
  getScoutNote: jest.fn(),
  getScoutNotes: jest.fn().mockReturnValue([]),
  // api keys
  insertApiKey: jest.fn(),
  listApiKeysByWallet: jest.fn().mockReturnValue([]),
  revokeApiKeyById: jest.fn(),
  getApiKeyByHash: jest.fn().mockReturnValue(null),
  getActiveApiKeyByLookupHash: jest.fn().mockReturnValue(null),
  getActiveApiKeysAwaitingLookupHash: jest.fn().mockReturnValue([]),
  setApiKeyLookupHash: jest.fn(),
  touchApiKeyLastUsed: jest.fn(),
  // bookmarks
  insertBookmark: jest.fn(),
  deleteBookmark: jest.fn(),
  getBookmarksByScout: jest.fn(),
  insertBookmarkFolder: jest.fn(),
  getBookmarkFoldersByScout: jest.fn(),
  getBookmarkFolderById: jest.fn(),
  deleteBookmarkFolder: jest.fn(),
  moveBookmarksToRoot: jest.fn(),
  countBookmarksInFolder: jest.fn(),
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
  getPlayerById,
  insertBookmark,
  deleteBookmark,
  getBookmarksByScout,
  insertBookmarkFolder,
  getBookmarkFoldersByScout,
  getBookmarkFolderById,
  deleteBookmarkFolder,
  moveBookmarksToRoot,
  countBookmarksInFolder,
} from '../../src/db';

const mockGetPlayerById        = getPlayerById        as jest.Mock;
const mockInsertBookmark       = insertBookmark       as jest.Mock;
const mockDeleteBookmark       = deleteBookmark       as jest.Mock;
const mockGetBookmarks         = getBookmarksByScout   as jest.Mock;
const mockInsertBookmarkFolder = insertBookmarkFolder as jest.Mock;
const mockGetBookmarkFolders   = getBookmarkFoldersByScout as jest.Mock;
const mockGetBookmarkFolderById = getBookmarkFolderById as jest.Mock;
const mockDeleteBookmarkFolder = deleteBookmarkFolder as jest.Mock;
const mockMoveBookmarksToRoot  = moveBookmarksToRoot  as jest.Mock;
const mockCountBookmarksInFolder = countBookmarksInFolder as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SCOUT_A   = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';
const SCOUT_B   = 'GAEZS7NMWCNTUFGDNXWVYVTKGGP47CESPEV5BVT5LNFHKXC5TGBZ4O5O';
const PLAYER_ID = 'player-abc-123';

const MOCK_PLAYER = {
  player_id: PLAYER_ID,
  wallet: 'GBXDL7VCREKVMQWV3ZL4BK3OFZZUVRKUTPHKCDPUMOVMCUFLZGKQMXWY',
  position: 'Forward',
  region: 'West Africa',
  metadata_uri: 'ipfs://QmTest',
  progress_level: 2,
  created_at: 1_700_000_000,
};

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const scoutAToken = makeToken(SCOUT_A);
const scoutBToken = makeToken(SCOUT_B);

// ─── POST /api/scouts/:wallet/bookmarks ─────────────────────────────────────

describe('POST /api/scouts/:wallet/bookmarks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('bookmarks a player and returns 200', async () => {
    mockGetPlayerById.mockReturnValueOnce(MOCK_PLAYER);
    mockInsertBookmark.mockReturnValueOnce(true);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmarks`)
      .send({ playerId: PLAYER_ID })
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.player_id).toBe(PLAYER_ID);
    expect(mockInsertBookmark).toHaveBeenCalledTimes(1);
  });

  it('bookmarks a player with folder and note', async () => {
    mockGetPlayerById.mockReturnValueOnce(MOCK_PLAYER);
    mockGetBookmarkFolderById.mockReturnValueOnce({ id: 1, scout_wallet: SCOUT_A, name: 'Test Folder', created_at: 1 });
    mockInsertBookmark.mockReturnValueOnce(true);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmarks`)
      .send({ playerId: PLAYER_ID, folderId: 1, note: 'Great player' })
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.player_id).toBe(PLAYER_ID);
    expect(res.body.data.folder_id).toBe(1);
    expect(res.body.data.note).toBe('Great player');
  });

  it('is idempotent — re-bookmarking does not error (INSERT OR IGNORE)', async () => {
    mockGetPlayerById.mockReturnValue(MOCK_PLAYER);
    mockInsertBookmark.mockReturnValue(false); // already existed

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmarks`)
      .send({ playerId: PLAYER_ID })
      .set('Authorization', `Bearer ${scoutAToken}`);

    // Must still return 200, not 409
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 404 when player does not exist', async () => {
    mockGetPlayerById.mockReturnValueOnce(null);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmarks`)
      .send({ playerId: PLAYER_ID })
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
    expect(mockInsertBookmark).not.toHaveBeenCalled();
  });

  it('returns 404 when folder does not exist', async () => {
    mockGetPlayerById.mockReturnValueOnce(MOCK_PLAYER);
    mockGetBookmarkFolderById.mockReturnValueOnce(null);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmarks`)
      .send({ playerId: PLAYER_ID, folderId: 999 })
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
    expect(mockInsertBookmark).not.toHaveBeenCalled();
  });

  it('returns 400 when playerId is missing', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmarks`)
      .send({})
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('playerId is required');
  });

  it('returns 403 when scout tries to bookmark under a different wallet', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_B}/bookmarks`)
      .send({ playerId: PLAYER_ID })
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(403);
    expect(mockInsertBookmark).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmarks`)
      .send({ playerId: PLAYER_ID });

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-scout role', async () => {
    const playerToken = makeToken(SCOUT_A, 'player');
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmarks`)
      .send({ playerId: PLAYER_ID })
      .set('Authorization', `Bearer ${playerToken}`);

    expect(res.status).toBe(403);
  });
});

// ─── DELETE /api/scouts/:wallet/bookmarks/:playerId ───────────────────────────

describe('DELETE /api/scouts/:wallet/bookmarks/:playerId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('removes a bookmark and returns 200', async () => {
    mockDeleteBookmark.mockReturnValueOnce(true);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/bookmarks/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);
    expect(mockDeleteBookmark).toHaveBeenCalledWith(SCOUT_A, PLAYER_ID);
  });

  it('returns 404 when bookmark does not exist', async () => {
    mockDeleteBookmark.mockReturnValueOnce(false);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/bookmarks/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
  });

  it('returns 403 for cross-wallet delete', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/bookmarks/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockDeleteBookmark).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/bookmarks/${PLAYER_ID}`);

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/scouts/:wallet/bookmarks ───────────────────────────────────────

describe('GET /api/scouts/:wallet/bookmarks', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns full player profile summaries (not bare ids)', async () => {
    mockGetBookmarks.mockReturnValueOnce([
      { id: 1, scout_wallet: SCOUT_A, player_id: PLAYER_ID, folder_id: null, note: null, created_at: 1_700_000_010 },
    ]);
    mockGetPlayerById.mockReturnValueOnce(MOCK_PLAYER);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/bookmarks`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);

    const p = res.body.data[0];
    // Must be a full profile summary with tier meta, not just player_id
    expect(p.player_id).toBe(PLAYER_ID);
    expect(p.wallet).toBeDefined();
    expect(p.position).toBeDefined();
    expect(p.region).toBeDefined();
    expect(p.progress_level).toBeDefined();
    expect(p.tierName).toBeDefined();
    expect(p.tierDescription).toBeDefined();
    expect(p.bookmarked_at).toBe(1_700_000_010);
    expect(p.folder_id).toBeNull();
    expect(p.note).toBeNull();
  });

  it('filters by folderId when query param is provided', async () => {
    mockGetBookmarks.mockReturnValueOnce([
      { id: 1, scout_wallet: SCOUT_A, player_id: PLAYER_ID, folder_id: 1, note: 'Test note', created_at: 1_700_000_010 },
    ]);
    mockGetPlayerById.mockReturnValueOnce(MOCK_PLAYER);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/bookmarks?folderId=1`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(mockGetBookmarks).toHaveBeenCalledWith(SCOUT_A, 1);
  });

  it('skips bookmarks for players that no longer exist', async () => {
    mockGetBookmarks.mockReturnValueOnce([
      { id: 1, scout_wallet: SCOUT_A, player_id: 'deleted-player', folder_id: null, note: null, created_at: 1 },
      { id: 2, scout_wallet: SCOUT_A, player_id: PLAYER_ID, folder_id: null, note: null, created_at: 2 },
    ]);
    // deleted-player returns null; MOCK_PLAYER is returned for the second
    mockGetPlayerById
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(MOCK_PLAYER);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/bookmarks`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].player_id).toBe(PLAYER_ID);
  });

  it('returns empty array when scout has no bookmarks', async () => {
    mockGetBookmarks.mockReturnValueOnce([]);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/bookmarks`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 403 for cross-scout access', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/bookmarks`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
    expect(mockGetBookmarks).not.toHaveBeenCalled();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/bookmarks`);

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-scout role', async () => {
    const playerToken = makeToken(SCOUT_A, 'player');
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/bookmarks`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(res.status).toBe(403);
  });
});

// ─── Add / list / remove cycle ────────────────────────────────────────────────

describe('add / list / remove bookmark cycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('completes the full add → list → remove lifecycle', async () => {
    // 1. Add
    mockGetPlayerById.mockReturnValue(MOCK_PLAYER);
    mockInsertBookmark.mockReturnValueOnce(true);

    const addRes = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmarks`)
      .send({ playerId: PLAYER_ID })
      .set('Authorization', `Bearer ${scoutAToken}`);
    expect(addRes.status).toBe(200);

    // 2. List
    mockGetBookmarks.mockReturnValueOnce([
      { id: 1, scout_wallet: SCOUT_A, player_id: PLAYER_ID, folder_id: null, note: null, created_at: 1 },
    ]);
    mockGetPlayerById.mockReturnValueOnce(MOCK_PLAYER);

    const listRes = await request(app)
      .get(`/api/scouts/${SCOUT_A}/bookmarks`)
      .set('Authorization', `Bearer ${scoutAToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(1);

    // 3. Remove
    mockDeleteBookmark.mockReturnValueOnce(true);

    const delRes = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/bookmarks/${PLAYER_ID}`)
      .set('Authorization', `Bearer ${scoutAToken}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.data.removed).toBe(true);
  });
});

// ─── Bookmark folders ─────────────────────────────────────────────────────────

describe('POST /api/scouts/:wallet/bookmark-folders', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a folder and returns 201', async () => {
    mockInsertBookmarkFolder.mockReturnValueOnce(1);

    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmark-folders`)
      .send({ name: 'Prospects' })
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(1);
    expect(res.body.data.name).toBe('Prospects');
    expect(mockInsertBookmarkFolder).toHaveBeenCalledWith({
      scout_wallet: SCOUT_A,
      name: 'Prospects',
      created_at: expect.any(Number),
    });
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_A}/bookmark-folders`)
      .send({})
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name is required and must be a string');
  });

  it('returns 403 for cross-wallet access', async () => {
    const res = await request(app)
      .post(`/api/scouts/${SCOUT_B}/bookmark-folders`)
      .send({ name: 'Test' })
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(403);
  });
});

describe('GET /api/scouts/:wallet/bookmark-folders', () => {
  beforeEach(() => jest.clearAllMocks());

  it('lists folders with bookmark counts', async () => {
    mockGetBookmarkFolders.mockReturnValueOnce([
      { id: 1, scout_wallet: SCOUT_A, name: 'Prospects', created_at: 1 },
      { id: 2, scout_wallet: SCOUT_A, name: 'Watchlist', created_at: 2 },
    ]);
    mockCountBookmarksInFolder.mockImplementation((id) => id === 1 ? 5 : 3);

    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/bookmark-folders`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].bookmark_count).toBe(5);
    expect(res.body.data[1].bookmark_count).toBe(3);
  });

  it('returns 403 for cross-scout access', async () => {
    const res = await request(app)
      .get(`/api/scouts/${SCOUT_A}/bookmark-folders`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/scouts/:wallet/bookmark-folders/:folderId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes folder and moves bookmarks to root', async () => {
    mockGetBookmarkFolderById.mockReturnValueOnce({ id: 1, scout_wallet: SCOUT_A, name: 'Test', created_at: 1 });
    mockDeleteBookmarkFolder.mockReturnValueOnce(true);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/bookmark-folders/1`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.deleted).toBe(true);
    expect(mockMoveBookmarksToRoot).toHaveBeenCalledWith(1, SCOUT_A);
    expect(mockDeleteBookmarkFolder).toHaveBeenCalledWith(1, SCOUT_A);
  });

  it('returns 404 when folder does not exist', async () => {
    mockGetBookmarkFolderById.mockReturnValueOnce(null);

    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/bookmark-folders/999`)
      .set('Authorization', `Bearer ${scoutAToken}`);

    expect(res.status).toBe(404);
    expect(mockMoveBookmarksToRoot).not.toHaveBeenCalled();
  });

  it('returns 403 for cross-wallet delete', async () => {
    const res = await request(app)
      .delete(`/api/scouts/${SCOUT_A}/bookmark-folders/1`)
      .set('Authorization', `Bearer ${scoutBToken}`);

    expect(res.status).toBe(403);
  });
});
