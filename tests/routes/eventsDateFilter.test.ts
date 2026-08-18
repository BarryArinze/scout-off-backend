/**
 * #302 — getAllEvents date filtering uses created_at
 *
 * Verifies:
 *  - GET /api/admin/events?startDate=X&endDate=Y returns only events in the range
 *  - Events with created_at outside the range are excluded
 */

import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import app from '../../src/app';
import { EventRecord } from '../../src/types';

// Jan 2024 = 1704067200000 ms
const JAN_2024_MS = 1704067200000;
// Jul 2024 = 1719792000000 ms
const JUL_2024_MS = 1719792000000;
// Jan 2025 = 1735689600000 ms
const JAN_2025_MS = 1735689600000;

const EVENT_JAN: EventRecord = {
  source: 'contract',
  contractAddress: 'contract',
  type: 'player_registered',
  payload: { player_id: 'p-jan' },
  created_at: JAN_2024_MS,
};

const EVENT_JUL: EventRecord = {
  source: 'contract',
  contractAddress: 'contract',
  type: 'player_registered',
  payload: { player_id: 'p-jul' },
  created_at: JUL_2024_MS,
};

const EVENT_JAN25: EventRecord = {
  source: 'contract',
  contractAddress: 'contract',
  type: 'player_registered',
  payload: { player_id: 'p-jan25' },
  created_at: JAN_2025_MS,
};

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
  getEventsCount: jest.fn().mockReturnValue(3),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  getValidatorStats: jest.fn().mockReturnValue(null),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getPlayerById: jest.fn().mockReturnValue(null),
  insertPlayerProfileHistory: jest.fn(),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  withdrawFees: jest.fn(),
  stellarHealth: jest.fn().mockResolvedValue('ok'),
  FeeWithdrawalError: class extends Error {},
}));

jest.mock('../../src/services/audit', () => ({
  logAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

import { queryEvents } from '../../src/db';
const mockGetEvents = queryEvents as jest.Mock;

async function getAdminToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'admin' });
  return tokenRes.body.token;
}

describe('#302 GET /api/admin/events — date filter uses created_at', () => {
  beforeEach(() => {
    mockGetEvents.mockReturnValue([EVENT_JAN, EVENT_JUL, EVENT_JAN25]);
  });

  it('returns only events within startDate–endDate range', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`)
      .query({
        startDate: '2024-01-01T00:00:00.000Z',
        endDate:   '2024-12-31T23:59:59.999Z',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Only JAN_2024 and JUL_2024 fall within 2024; JAN_2025 is excluded.
    const ids = res.body.data.map((e: EventRecord) => e.payload.player_id);
    expect(ids).toContain('p-jan');
    expect(ids).toContain('p-jul');
    expect(ids).not.toContain('p-jan25');
  });

  it('returns all events when no date filter is applied', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it('excludes all events when range has no matches', async () => {
    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/events')
      .set('Authorization', `Bearer ${token}`)
      .query({
        startDate: '2020-01-01T00:00:00.000Z',
        endDate:   '2020-12-31T23:59:59.999Z',
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});
