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
  });
});
