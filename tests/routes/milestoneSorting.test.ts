/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([
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
  ]),
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
    const res = await request(app).get('/api/players/player-1/milestones?sortBy=submittedAt&order=asc');
    expect(res.status).toBe(200);
    const timestamps = res.body.data.map((m: any) => m.submittedAt);
    expect(timestamps).toEqual([1000, 2000, 3000]);
  });

  it('sorts by submittedAt descending', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?sortBy=submittedAt&order=desc');
    expect(res.status).toBe(200);
    const timestamps = res.body.data.map((m: any) => m.submittedAt);
    expect(timestamps).toEqual([3000, 2000, 1000]);
  });

  it('sorts by approvedAt ascending', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?sortBy=approvedAt&order=asc');
    expect(res.status).toBe(200);
    const timestamps = res.body.data.map((m: any) => m.approvedAt);
    expect(timestamps).toEqual([1000, 2000, 3000]);
  });

  it('sorts by approvedAt descending', async () => {
    const res = await request(app).get('/api/players/player-1/milestones?sortBy=approvedAt&order=desc');
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
