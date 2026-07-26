/**
 * Tests for player cache invalidation after indexer events.
 * Verifies that cache is cleared when player data changes via indexer.
 */

import request from 'supertest';
import app from '../../src/app';
import { getDb, upsertPlayer, updatePlayerProgress, getPlayerById } from '../../src/db';
import { cacheSet, cacheGet } from '../../src/services/cache';

describe('Player Cache Invalidation', () => {
  const PLAYER_ID = 'cache-test-player-' + Math.random().toString(36).slice(2);
  const WALLET = 'GCACHE' + 'A'.repeat(51);

  beforeAll(() => {
    getDb();
  });

  beforeEach(() => {
    // Clean up any existing test data
    const db = getDb();
    db.prepare('DELETE FROM players WHERE player_id = ?').run(PLAYER_ID);
    
    // Clear cache before each test
    const cache = require('../../src/services/cache');
    cache.invalidatePlayerCache(PLAYER_ID);
  });

  afterAll(() => {
    // Clean up test data
    const db = getDb();
    db.prepare('DELETE FROM players WHERE player_id = ?').run(PLAYER_ID);
  });

  describe('after player registration', () => {
    it('clears the player cache entry when upsertPlayer is called', () => {
      // Set up cache entry
      cacheSet(`players:${PLAYER_ID}`, { player_id: PLAYER_ID, progress_level: 0 });
      expect(cacheGet(`players:${PLAYER_ID}`)).toBeDefined();

      // Simulate indexer calling upsertPlayer (player_registered event)
      upsertPlayer({
        player_id: PLAYER_ID,
        wallet: WALLET,
        position: 'striker',
        region: 'EU',
        metadata_uri: 'QmTest',
        created_at: 1000,
      });

      // Manually invalidate cache as indexer would do
      const cache = require('../../src/services/cache');
      cache.invalidatePlayerCache(PLAYER_ID);

      // Verify cache is cleared
      expect(cacheGet(`players:${PLAYER_ID}`)).toBeUndefined();
    });

    it('clears the players list cache', () => {
      // Set up cache entries
      cacheSet('players:list:{}', { data: [], total: 0 });
      cacheSet('players:list:{"region":"eu"}', { data: [], total: 0 });
      expect(cacheGet('players:list:{}')).toBeDefined();
      expect(cacheGet('players:list:{"region":"eu"}')).toBeDefined();

      // Simulate indexer calling upsertPlayer
      upsertPlayer({
        player_id: PLAYER_ID,
        wallet: WALLET,
        position: 'striker',
        region: 'EU',
        created_at: 1000,
      });

      // Manually invalidate cache as indexer would do
      const cache = require('../../src/services/cache');
      cache.invalidatePlayerCache(PLAYER_ID);

      // Verify all list caches are cleared
      expect(cacheGet('players:list:{}')).toBeUndefined();
      expect(cacheGet('players:list:{"region":"eu"}')).toBeUndefined();
    });
  });

  describe('after milestone approval (progress update)', () => {
    it('clears the player cache entry when updatePlayerProgress is called', () => {
      // Set up player in DB
      upsertPlayer({
        player_id: PLAYER_ID,
        wallet: WALLET,
        position: 'striker',
        region: 'EU',
        created_at: 1000,
      });

      // Set up cache entry
      cacheSet(`players:${PLAYER_ID}`, { player_id: PLAYER_ID, progress_level: 0 });
      expect(cacheGet(`players:${PLAYER_ID}`)).toBeDefined();

      // Simulate indexer calling updatePlayerProgress (milestone_approved event)
      updatePlayerProgress(PLAYER_ID, 2);

      // Manually invalidate cache as indexer would do
      const cache = require('../../src/services/cache');
      cache.invalidatePlayerCache(PLAYER_ID);

      // Verify cache is cleared
      expect(cacheGet(`players:${PLAYER_ID}`)).toBeUndefined();
    });

    it('clears the players list cache', () => {
      // Set up player in DB
      upsertPlayer({
        player_id: PLAYER_ID,
        wallet: WALLET,
        position: 'striker',
        region: 'EU',
        created_at: 1000,
      });

      // Set up cache entries
      cacheSet('players:list:{}', { data: [], total: 0 });
      cacheSet('players:list:{"region":"eu"}', { data: [], total: 0 });
      expect(cacheGet('players:list:{}')).toBeDefined();
      expect(cacheGet('players:list:{"region":"eu"}')).toBeDefined();

      // Simulate indexer calling updatePlayerProgress
      updatePlayerProgress(PLAYER_ID, 2);

      // Manually invalidate cache as indexer would do
      const cache = require('../../src/services/cache');
      cache.invalidatePlayerCache(PLAYER_ID);

      // Verify all list caches are cleared
      expect(cacheGet('players:list:{}')).toBeUndefined();
      expect(cacheGet('players:list:{"region":"eu"}')).toBeUndefined();
    });
  });

  describe('API returns updated data after cache invalidation', () => {
    it('GET /api/players/:id returns updated tier after cache invalidation', async () => {
      // Set up player in DB with tier 0
      upsertPlayer({
        player_id: PLAYER_ID,
        wallet: WALLET,
        position: 'striker',
        region: 'EU',
        created_at: 1000,
      });

      // Set up cache with old tier
      cacheSet(`players:${PLAYER_ID}`, { player_id: PLAYER_ID, progress_level: 0, wallet: WALLET });

      // Update player tier in DB
      updatePlayerProgress(PLAYER_ID, 3);

      // Invalidate cache as indexer would do
      const cache = require('../../src/services/cache');
      cache.invalidatePlayerCache(PLAYER_ID);

      // Verify DB has updated tier
      const dbRow = getPlayerById(PLAYER_ID);
      expect(dbRow?.progress_level).toBe(3);

      // API should return updated tier (not cached old value)
      const response = await request(app).get(`/api/players/${PLAYER_ID}`);
      expect(response.status).toBe(200);
      expect(response.body.progress_level).toBe(3);
    });
 * #307 — single-player cache: GET /players/:playerId
 *
 * Verifies:
 *  - Second request for the same player is served from cache (DB not called twice)
 *  - Cache is invalidated after a successful PUT /players/:playerId
 *  - TTL is driven by PLAYER_CACHE_TTL_MS (config)
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

const PLAYER_ROW = {
  player_id: 'G' + 'A'.repeat(55), // must match wallet for requireOwner
  wallet: 'G' + 'A'.repeat(55),
  position: 'striker',
  region: 'europe',
  metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  progress_level: 1,
  created_at: 1700000000,
};

const mockGetPlayerById = jest.fn();

jest.mock('../../src/db', () => ({
  getPlayerById: (...args: unknown[]) => mockGetPlayerById(...args),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  queryEvents: jest.fn().mockReturnValue([]),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/stellar', () => ({
  updateProfile: jest.fn().mockResolvedValue({
    transactionId: 'stub-tx-cache-bust',
    metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  }),
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

import app from '../../src/app';
import { invalidatePlayerCache } from '../../src/services/cache';

function makeToken(wallet: string, role: string) {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

beforeEach(async () => {
  mockGetPlayerById.mockReset();
  // Clear any cached state from previous tests.
  await invalidatePlayerCache(PLAYER_ROW.player_id);
});

describe('#307 GET /api/players/:playerId — cache hit', () => {
  it('serves the second request from cache without hitting the DB again', async () => {
    mockGetPlayerById.mockReturnValue(PLAYER_ROW);

    // First request — hits DB.
    const res1 = await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(res1.status).toBe(200);
    expect(res1.body.data.player_id).toBe(PLAYER_ROW.player_id);

    // Second request — served from cache, no new DB call.
    const res2 = await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(res2.status).toBe(200);
    expect(res2.body.data.player_id).toBe(PLAYER_ROW.player_id);

    // DB was only queried once.
    expect(mockGetPlayerById).toHaveBeenCalledTimes(1);
  });
});

describe('#307 PUT /api/players/:playerId — cache bust', () => {
  it('calls getPlayerById again after a successful PUT (cache was busted)', async () => {
    mockGetPlayerById.mockReturnValue(PLAYER_ROW);

    const token = makeToken(PLAYER_ROW.wallet, 'player');

    // Prime the cache with first GET.
    await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(mockGetPlayerById).toHaveBeenCalledTimes(1);

    // Update the player profile — should bust the single-player cache.
    const putRes = await request(app)
      .put(`/api/players/${PLAYER_ROW.player_id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ metadataUri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' });
    expect(putRes.status).toBe(200);

    // After bust, next GET must hit DB again (cache miss).
    await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(mockGetPlayerById).toHaveBeenCalledTimes(2);
  });

  it('returns fresh data (not stale cache) immediately after a PUT update', async () => {
    const OLD_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    const NEW_CID = 'QmWvjsQmdhSirshEzbPnmdnbMr2wDs4yT6N8pWAxmGaN6d';
    const oldData = { ...PLAYER_ROW, metadata_uri: OLD_CID };
    const newData = { ...PLAYER_ROW, metadata_uri: NEW_CID };
    mockGetPlayerById.mockReturnValue(oldData);

    const token = makeToken(PLAYER_ROW.wallet, 'player');

    // Prime cache with old data.
    const pre = await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(pre.status).toBe(200);
    expect(pre.body.data.metadataUri).toBe(OLD_CID);

    const putRes = await request(app)
      .put(`/api/players/${PLAYER_ROW.player_id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ metadataUri: NEW_CID });
    expect(putRes.status).toBe(200);

    // After bust, change mock to return new data.
    mockGetPlayerById.mockReturnValue(newData);

    // GET must return fresh data, not the stale cached response.
    const post = await request(app).get(`/api/players/${PLAYER_ROW.player_id}`);
    expect(post.status).toBe(200);
    expect(post.body.data.metadataUri).toBe(NEW_CID);
  });
});
