import { getStats } from '../../src/controllers/adminController';
import * as db from '../../src/db';
import { cacheGet, cacheSet } from '../../src/services/cache';

describe('Admin Controller - Time-series Stats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/admin/stats with time-series', () => {
    it('should return 400 for invalid window parameter', async () => {
      const req = { query: { window: 'invalid' } } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.any(String),
        })
      );
    });

    it('should return time-series data for 7d window', async () => {
      const mockTimeSeries = [
        { date: '2026-07-22', count: 5 },
        { date: '2026-07-23', count: 3 },
        { date: '2026-07-24', count: 8 },
        { date: '2026-07-25', count: 2 },
        { date: '2026-07-26', count: 4 },
        { date: '2026-07-27', count: 6 },
        { date: '2026-07-28', count: 7 },
      ];

      jest.spyOn(db, 'getNewPlayersTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getMilestonesApprovedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getContactUnlocksTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getSubscriptionsStartedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(require('../../src/services/cache'), 'cacheGet').mockResolvedValue(undefined);
      jest.spyOn(require('../../src/services/cache'), 'cacheSet').mockResolvedValue(undefined);

      const req = { query: { window: '7d' } } as any;
      const res = {
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          window: '7d',
          newPlayers: mockTimeSeries,
          milestonesApproved: mockTimeSeries,
          contactUnlocks: mockTimeSeries,
          subscriptionsStarted: mockTimeSeries,
        }),
      });

      expect(db.getNewPlayersTimeSeries).toHaveBeenCalled();
      expect(require('../../src/services/cache').cacheSet).toHaveBeenCalledWith(
        'admin:stats:7d:none',
        expect.any(Object),
        300000
      );
    });

    it('should return time-series data for 30d window', async () => {
      const mockTimeSeries = Array.from({ length: 30 }, (_, i) => ({
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
        count: Math.floor(Math.random() * 10) + 1,
      }));

      jest.spyOn(db, 'getNewPlayersTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getMilestonesApprovedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getContactUnlocksTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getSubscriptionsStartedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(require('../../src/services/cache'), 'cacheGet').mockResolvedValue(undefined);
      jest.spyOn(require('../../src/services/cache'), 'cacheSet').mockResolvedValue(undefined);

      const req = { query: { window: '30d' } } as any;
      const res = {
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          window: '30d',
          newPlayers: mockTimeSeries,
          milestonesApproved: mockTimeSeries,
          contactUnlocks: mockTimeSeries,
          subscriptionsStarted: mockTimeSeries,
        }),
      });
    });

    it('should return cached data when available', async () => {
      const cachedData = {
        window: '7d',
        startDate: '2026-07-22',
        endDate: '2026-07-28',
        newPlayers: [{ date: '2026-07-22', count: 5 }],
        milestonesApproved: [{ date: '2026-07-22', count: 3 }],
        contactUnlocks: [{ date: '2026-07-22', count: 2 }],
        subscriptionsStarted: [{ date: '2026-07-22', count: 1 }],
      };

      jest.spyOn(require('../../src/services/cache'), 'cacheGet').mockResolvedValue({ data: cachedData });
      jest.spyOn(db, 'getNewPlayersTimeSeries').mockReturnValue([]);

      const req = { query: { window: '7d' } } as any;
      const res = {
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: cachedData,
      });

      expect(db.getNewPlayersTimeSeries).not.toHaveBeenCalled();
    });

    it('should include region breakdown when requested', async () => {
      const mockTimeSeries = [
        { date: '2026-07-22', count: 5 },
        { date: '2026-07-23', count: 3 },
      ];

      const mockRegionBreakdown = [
        { date: '2026-07-22', region: 'NA', count: 3 },
        { date: '2026-07-22', region: 'EU', count: 2 },
        { date: '2026-07-23', region: 'NA', count: 2 },
        { date: '2026-07-23', region: 'EU', count: 1 },
      ];

      jest.spyOn(db, 'getNewPlayersTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getMilestonesApprovedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getContactUnlocksTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getSubscriptionsStartedTimeSeries').mockReturnValue(mockTimeSeries);
      jest.spyOn(db, 'getNewPlayersByRegionTimeSeries').mockReturnValue(mockRegionBreakdown);
      jest.spyOn(require('../../src/services/cache'), 'cacheGet').mockResolvedValue(undefined);
      jest.spyOn(require('../../src/services/cache'), 'cacheSet').mockResolvedValue(undefined);

      const req = { query: { window: '7d', breakdown: 'region' } } as any;
      const res = {
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          window: '7d',
          newPlayers: mockTimeSeries,
          newPlayersByRegion: mockRegionBreakdown,
        }),
      });

      expect(db.getNewPlayersByRegionTimeSeries).toHaveBeenCalled();
    });

    it('should return basic stats when no window or breakdown requested (backward compatible)', async () => {
      jest.spyOn(db, 'queryEvents').mockImplementation((type?: string) => {
        if (type === 'player_registered') return [{}, {}, {}] as any;
        if (type === 'milestone_approved') return [{}, {}] as any;
        if (type === 'scout_subscribed') return [{}] as any;
        return [{}, {}, {}, {}, {}] as any;
      });

      const req = { query: {} } as any;
      const res = {
        json: jest.fn(),
      } as any;
      const next = jest.fn();

      await getStats(req, res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          players: 3,
          milestones: 2,
          subscriptions: 1,
          events: 5,
        },
      });
    });
  });
});
