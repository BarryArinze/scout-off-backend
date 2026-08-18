import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  queryMilestones: jest.fn().mockResolvedValue([]),
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmTestCid'),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
  gatewayUrls: jest.fn((cid: string) => [`https://gateway.pinata.cloud/ipfs/${cid}`]),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/cache', () => ({
  cacheGet: jest.fn().mockReturnValue(undefined),
  cacheSet: jest.fn(),
  invalidatePlayerCache: jest.fn(),
}));

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn(),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  insertOrUpdatePlayer: jest.fn(),
  // src/utils/audit.ts's recordAudit (called from filterPlayers) calls this directly.
  insertAuditLog: jest.fn().mockResolvedValue({
    id: 1,
    action: 'mock',
    admin_wallet: '',
    query_params: '{}',
    created_at: new Date().toISOString(),
    prev_hash: null,
    hash: 'mock-hash',
    event_source: 'app_event',
  }),
}));

import { queryPlayers, countPlayers } from '../../src/db';

const mockQueryPlayers = queryPlayers as jest.Mock;
const mockCountPlayers = countPlayers as jest.Mock;

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const WALLET = 'G' + 'A'.repeat(55);

function makePlayers(count: number, startIndex = 0) {
  return Array.from({ length: count }, (_, i) => ({
    player_id: `player-${startIndex + i}`,
    wallet: `G${'P'.repeat(54)}${i}`,
    position: 'striker',
    region: 'europe',
    metadata_uri: null,
    progress_level: 0,
    created_at: Math.floor(Date.now() / 1000) - (startIndex + i) * 100,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/players — pagination', () => {
  it('returns first page with correct metadata for 25 total players', async () => {
    const allPlayers = makePlayers(25);
    mockQueryPlayers.mockReturnValue(allPlayers.slice(0, 10));
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.total).toBe(25);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
    expect(res.body.pages).toBe(3);
  });

  it('returns second page with correct subset', async () => {
    const page2Players = makePlayers(10, 10);
    mockQueryPlayers.mockReturnValue(page2Players);
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=2&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.data[0].player_id).toBe('player-10');
    expect(res.body.page).toBe(2);
    expect(res.body.pages).toBe(3);
    expect(mockQueryPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 10 }),
    );
  });

  it('returns last partial page correctly', async () => {
    const lastPage = makePlayers(5, 20);
    mockQueryPlayers.mockReturnValue(lastPage);
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=3&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.total).toBe(25);
    expect(res.body.pages).toBe(3);
    expect(mockQueryPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, offset: 20 }),
    );
  });

  it('returns empty data for page beyond total', async () => {
    mockQueryPlayers.mockReturnValue([]);
    mockCountPlayers.mockReturnValue(25);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=10&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.total).toBe(25);
    expect(res.body.pages).toBe(3);
  });

  it('returns single page when total fits in pageSize', async () => {
    const players = makePlayers(3);
    mockQueryPlayers.mockReturnValue(players);
    mockCountPlayers.mockReturnValue(3);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=1&pageSize=20')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.total).toBe(3);
    expect(res.body.pages).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
  });

  it('defaults to page=1 and pageSize=20 when not specified', async () => {
    mockQueryPlayers.mockReturnValue([]);
    mockCountPlayers.mockReturnValue(0);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.pages).toBe(0);
    expect(res.body.total).toBe(0);
    expect(mockQueryPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, offset: 0 }),
    );
  });

  it('passes correct offset for different page/pageSize combos', async () => {
    mockQueryPlayers.mockReturnValue([]);
    mockCountPlayers.mockReturnValue(100);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=4&pageSize=5')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pages).toBe(20);
    expect(mockQueryPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, offset: 15 }),
    );
  });

  it('calculates pages correctly for exact division', async () => {
    mockQueryPlayers.mockReturnValue(makePlayers(10));
    mockCountPlayers.mockReturnValue(30);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pages).toBe(3);
    expect(res.body.total).toBe(30);
  });

  it('calculates pages correctly for non-exact division', async () => {
    mockQueryPlayers.mockReturnValue(makePlayers(10));
    mockCountPlayers.mockReturnValue(31);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.pages).toBe(4);
    expect(res.body.total).toBe(31);
  });

  it('filters by region and returns correct pagination metadata', async () => {
    const filtered = makePlayers(2);
    mockQueryPlayers.mockReturnValue(filtered);
    mockCountPlayers.mockReturnValue(2);

    const token = makeToken(WALLET);
    const res = await request(app)
      .get('/api/players?region=europe&page=1&pageSize=10')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.pages).toBe(1);
    expect(mockQueryPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'europe', limit: 10, offset: 0 }),
    );
    expect(mockCountPlayers).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'europe' }),
    );
  });
});
