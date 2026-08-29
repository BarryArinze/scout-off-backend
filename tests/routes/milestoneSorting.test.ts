/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockImplementation((type?: string) => {
    if (type === 'milestone_approved') {
      return [
        {
          type: 'milestone_approved',
          payload: { player_id: 'player-1', submittedAt: 1000, approvedAt: 3000 },
        },
        {
          type: 'milestone_approved',
          payload: { player_id: 'player-1', submittedAt: 3000, approvedAt: 1000 },
        },
        {
          type: 'milestone_approved',
          payload: { player_id: 'player-1', submittedAt: 2000, approvedAt: 2000 },
        },
      ];
    }
    if (type === 'milestone_submitted') {
      return [
        {
          type: 'milestone_submitted',
          payload: { player_id: 'player-1', submittedAt: 500, approvedAt: null },
        },
        {
          type: 'milestone_submitted',
          payload: { player_id: 'player-1', submittedAt: 1500, approvedAt: null },
        },
      ];
    }
    return [];
  }),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getPlayerById: jest.fn().mockImplementation((id) => {
    if (id === 'player-1') {
      return {
        player_id: 'player-1',
        wallet: 'G' + 'A'.repeat(55),
        position: 'striker',
        region: 'europe',
        metadata_uri: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        progress_level: 1,
        created_at: 1700000000,
        is_active: 1,
      };
    }
    return null;
  }),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  insertOrUpdatePlayer: jest.fn(),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  pinFile: jest.fn(),
  gatewayUrl: jest.fn(),
  checkHealth: jest.fn(),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cache', () => ({
  invalidatePlayerCache: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  updateProfile: jest.fn().mockResolvedValue({ transactionId: 'stub-tx', metadataUri: 'QmStub' }),
  queryMilestones: jest.fn().mockResolvedValue([]),
}));

import app from '../../src/app';

describe('GET /api/players/:playerId/milestones - sorting', () => {
  it('returns milestones with default sort (asc by submittedAt)', async () => {
    const res = await request(app).get('/api/players/player-1/milestones');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('sorts by submittedAt ascending', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?status=approved&sortBy=submittedAt&order=asc');
    expect(res.status).toBe(200);
    const timestamps = res.body.data.map((m: any) => m.submittedAt);
    expect(timestamps).toEqual([1000, 2000, 3000]);
  });

  it('sorts by submittedAt descending', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?status=approved&sortBy=submittedAt&order=desc');
    expect(res.status).toBe(200);
    const timestamps = res.body.data.map((m: any) => m.submittedAt);
    expect(timestamps).toEqual([3000, 2000, 1000]);
  });

  it('sorts by approvedAt ascending', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?status=approved&sortBy=approvedAt&order=asc');
    expect(res.status).toBe(200);
    const timestamps = res.body.data.map((m: any) => m.approvedAt);
    expect(timestamps).toEqual([1000, 2000, 3000]);
  });

  it('sorts by approvedAt descending', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?status=approved&sortBy=approvedAt&order=desc');
    expect(res.status).toBe(200);
    const timestamps = res.body.data.map((m: any) => m.approvedAt);
    expect(timestamps).toEqual([3000, 2000, 1000]);
  });

  it('returns 400 for invalid sortBy value', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?sortBy=invalidField');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for invalid order value', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?order=random');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/players/:playerId/milestones - status filter', () => {
  it('?status=approved returns only approved milestones', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?status=approved');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const statuses: string[] = res.body.data.map((m: any) => m.status);
    expect(statuses.every((s) => s === 'approved')).toBe(true);
    expect(statuses.length).toBeGreaterThan(0);
  });

  it('?status=pending returns only pending milestones', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?status=pending');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const statuses: string[] = res.body.data.map((m: any) => m.status);
    expect(statuses.every((s) => s === 'pending')).toBe(true);
    expect(statuses.length).toBeGreaterThan(0);
  });

  it('default (no status param) returns both approved and pending milestones', async () => {
    const res = await request(app).get('/api/players/player-1/milestones');
    expect(res.status).toBe(200);
    const statuses: string[] = res.body.data.map((m: any) => m.status);
    expect(statuses).toContain('approved');
    expect(statuses).toContain('pending');
  });

  it('returns 400 for an invalid status value', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?status=invalid');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/players/:playerId/milestones - limit parameter', () => {
  it('?limit=2 returns exactly 2 results', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('?limit=1 returns exactly 1 result', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('?limit=50 (max) is accepted', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?limit=50');
    expect(res.status).toBe(200);
    // 3 approved + 2 pending = 5 total, all within limit=50
    expect(res.body.data.length).toBeLessThanOrEqual(50);
  });

  it('?limit=51 returns HTTP 400', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?limit=51');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('?limit=100 returns HTTP 400', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?limit=100');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('default limit is 20 (returns all 5 when total is 5)', async () => {
    const res = await request(app).get('/api/players/player-1/milestones');
    expect(res.status).toBe(200);
    // mock returns 3 approved + 2 pending = 5 total, under default limit of 20
    expect(res.body.data.length).toBe(5);
  });
});

describe('GET /api/players/:playerId/milestones - sort alias', () => {
  it('?sort=desc returns newest first (alias for order=desc)', async () => {
    const res = await request(app).get(
      '/api/players/player-1/milestones?status=approved&sortBy=submittedAt&sort=desc',
    );
    expect(res.status).toBe(200);
    const timestamps = res.body.data.map((m: any) => m.submittedAt);
    expect(timestamps).toEqual([3000, 2000, 1000]);
  });

  it('?sort=asc returns oldest first', async () => {
    const res = await request(app).get(
      '/api/players/player-1/milestones?status=approved&sortBy=submittedAt&sort=asc',
    );
    expect(res.status).toBe(200);
    const timestamps = res.body.data.map((m: any) => m.submittedAt);
    expect(timestamps).toEqual([1000, 2000, 3000]);
  });

  it('returns 400 for invalid sort alias value', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?sort=random');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/players/:playerId/milestones - combined params', () => {
  it('?status=approved&sort=desc&limit=2 returns 2 newest approved', async () => {
    const res = await request(app).get(
      '/api/players/player-1/milestones?status=approved&sort=desc&sortBy=submittedAt&limit=2',
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const statuses = res.body.data.map((m: any) => m.status);
    expect(statuses.every((s: string) => s === 'approved')).toBe(true);
    const timestamps = res.body.data.map((m: any) => m.submittedAt);
    // desc → 3000, 2000 (top 2)
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
  });
});

