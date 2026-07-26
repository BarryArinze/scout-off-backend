import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

const WALLET = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'GOTHERWALLET2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PLAYER_ID = 'player-trial-123';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  getPlayerById: jest.fn(),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  insertContactUnlock: jest.fn(),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  purchaseSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  submitContactPayment: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) {
      super(message);
    }
  },
}));

import { queryEvents, hasContactUnlock, getLatestSubscription } from '../../src/db';
import { isSubscribed, logTrialOffer } from '../../src/services/stellar';

const mockGetEvents = queryEvents as jest.Mock;
const mockHasContactUnlock = hasContactUnlock as jest.Mock;
const mockIsSubscribed = isSubscribed as jest.Mock;
const mockLogTrialOffer = logTrialOffer as jest.Mock;
const mockGetLatestSubscription = getLatestSubscription as jest.Mock;

function makeToken(wallet: string, role = 'scout'): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEvents.mockReturnValue([]);
  mockIsSubscribed.mockResolvedValue({ active: false, expiresAt: null });
  mockHasContactUnlock.mockReturnValue(false);
  mockGetLatestSubscription.mockReturnValue(null);
});

describe('POST /api/scouts/:wallet/trial-offer', () => {
  const VALID_BODY = {
    playerId: PLAYER_ID,
    detailsUri: 'ipfs://QmValidCid1234567890',
  };

  it('returns 404 when player is not found', async () => {
    mockGetEvents.mockImplementation((type?: string) => {
      if (type === 'player_registered') return [];
      return [];
    });
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/player not found/i);
  });

  it('returns 402 when scout lacks access (no subscription or unlock)', async () => {
    mockGetEvents.mockImplementation((type?: string) => {
      if (type === 'player_registered') {
        return [
          {
            source: 'contract',
            type: 'player_registered',
            contractAddress: 'contract',
            payload: { player_id: PLAYER_ID, wallet: 'GPLAYERWALLET' },
          },
        ];
      }
      if (type === 'scout_subscribed') return [];
      return [];
    });
    mockIsSubscribed.mockResolvedValue({ active: false, expiresAt: null });
    mockHasContactUnlock.mockReturnValue(false);
    mockGetLatestSubscription.mockReturnValue(null);

    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(402);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/subscribed|contact fee/i);
  });

  it('returns 403 when JWT wallet does not match path wallet', async () => {
    const token = makeToken(OTHER);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/wallet/i);
  });

  it('returns 400 for invalid detailsUri', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: PLAYER_ID, detailsUri: 'ftp://bad-uri' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when playerId is missing', async () => {
    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${token}`)
      .send({ detailsUri: 'ipfs://QmValidCid' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 201 on successful offer when scout has contact unlock', async () => {
    mockGetEvents.mockImplementation((type?: string) => {
      if (type === 'player_registered') {
        return [
          {
            source: 'contract',
            type: 'player_registered',
            contractAddress: 'contract',
            payload: { player_id: PLAYER_ID, wallet: 'GPLAYERWALLET' },
          },
        ];
      }
      if (type === 'scout_subscribed') return [];
      return [];
    });
    mockHasContactUnlock.mockReturnValue(true);
    mockLogTrialOffer.mockResolvedValue({
      transactionId: 'tx-offer-1',
      offerId: 'offer-1',
    });

    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBe('tx-offer-1');
    expect(mockLogTrialOffer).toHaveBeenCalledWith(WALLET, PLAYER_ID, VALID_BODY.detailsUri);
  });

  it('returns 201 on successful offer when scout has active subscription', async () => {
    mockGetEvents.mockImplementation((type?: string) => {
      if (type === 'player_registered') {
        return [
          {
            source: 'contract',
            type: 'player_registered',
            contractAddress: 'contract',
            payload: { player_id: PLAYER_ID, wallet: 'GPLAYERWALLET' },
          },
        ];
      }
      if (type === 'scout_subscribed') return [];
      return [];
    });
    mockIsSubscribed.mockResolvedValue({ active: true, expiresAt: Math.floor(Date.now() / 1000) + 86400 });
    mockLogTrialOffer.mockResolvedValue({
      transactionId: 'tx-offer-2',
      offerId: 'offer-2',
    });

    const token = makeToken(WALLET);
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 403 when token role is not scout', async () => {
    const token = makeToken(WALLET, 'player');
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/trial-offer`)
      .set('Authorization', `Bearer ${token}`)
      .send(VALID_BODY);
    expect(res.status).toBe(403);
  });
});
