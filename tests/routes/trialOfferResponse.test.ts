/**
 * Tests for:
 *   POST /api/players/:playerId/trial-offers/:offerId/accept
 *   POST /api/players/:playerId/trial-offers/:offerId/reject
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

// ─── Shared mock state ────────────────────────────────────────────────────────

// Player wallet (the wallet that registered as "player")
const PLAYER_WALLET = 'GPLAYERWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PLAYER_ID     = 'player-abc-123';
const OTHER_WALLET  = 'GOTHERWALLET2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SCOUT_WALLET  = 'GSCOUTWALLET1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OFFER_ID      = 'offer-xyz-789';

// In-memory store for mocked trial offers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _offers: any[] = [];

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockImplementation((type?: string) => {
    if (type === 'player_registered') {
      return [
        {
          source: 'contract',
          type: 'player_registered',
          contractAddress: 'contract',
          payload: { player_id: PLAYER_ID, wallet: PLAYER_WALLET },
        },
      ];
    }
    if (type === 'trial_offer_logged') {
      return [];
    }
    return [];
  }),
  getTrialOfferById: jest.fn(),
  insertTrialOffer: jest.fn(),
  respondToTrialOffer: jest.fn(),
}));

// Ensure we can update the player_registered event wallet in tests
import { queryEvents, getTrialOfferById, insertTrialOffer, respondToTrialOffer } from '../../src/db';

const mockGetEvents = queryEvents as jest.Mock;
const mockGetOffer = getTrialOfferById as jest.Mock;
const mockInsertOffer = insertTrialOffer as jest.Mock;
const mockRespondOffer = respondToTrialOffer as jest.Mock;

function makePlayerToken(wallet: string): string {
  return jwt.sign({ sub: wallet, role: 'player' }, SECRET, { expiresIn: '1h' });
}

const pendingOffer = {
  id: 1,
  offer_id: OFFER_ID,
  scout_wallet: SCOUT_WALLET,
  player_id: PLAYER_ID,
  details_uri: 'ipfs://offer-details',
  status: 'pending',
  reject_reason: null,
  responded_at: null,
  created_at: Math.floor(Date.now() / 1000) - 3600,
};

beforeEach(() => {
  mockGetOffer.mockReset();
  mockInsertOffer.mockReset();
  mockRespondOffer.mockReset();
  mockGetEvents.mockImplementation((type?: string) => {
    if (type === 'player_registered') {
      return [
        {
          source: 'contract',
          type: 'player_registered',
          contractAddress: 'contract',
          payload: { player_id: PLAYER_ID, wallet: PLAYER_WALLET },
        },
      ];
    }
    return [];
  });
});

// ─── POST /accept ─────────────────────────────────────────────────────────────

describe(`POST /api/players/${PLAYER_ID}/trial-offers/${OFFER_ID}/accept`, () => {
  const ACCEPT_URL = `/api/players/${PLAYER_ID}/trial-offers/${OFFER_ID}/accept`;

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).post(ACCEPT_URL);
    expect(res.status).toBe(401);
  });

  it('returns 403 when a scout JWT tries to accept', async () => {
    const token = jwt.sign({ sub: PLAYER_WALLET, role: 'scout' }, SECRET, { expiresIn: '1h' });
    const res = await request(app).post(ACCEPT_URL).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 when a different player tries to accept another player\'s offer', async () => {
    mockGetOffer.mockReturnValue(pendingOffer);
    const token = makePlayerToken(OTHER_WALLET);
    const res = await request(app).post(ACCEPT_URL).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/do not own/i);
  });

  it('returns 404 when the offer does not exist', async () => {
    mockGetOffer.mockReturnValue(null);
    const token = makePlayerToken(PLAYER_WALLET);
    const res = await request(app).post(ACCEPT_URL).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 200 and records acceptance for the offer owner', async () => {
    mockGetOffer.mockReturnValue(pendingOffer);

    const token = makePlayerToken(PLAYER_WALLET);
    const res = await request(app).post(ACCEPT_URL).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.offerId).toBe(OFFER_ID);
    expect(res.body.data.status).toBe('accepted');
    expect(res.body.data.respondedAt).toBeGreaterThan(0);

    expect(mockRespondOffer).toHaveBeenCalledWith(
      expect.objectContaining({ offer_id: OFFER_ID, status: 'accepted' }),
    );
  });

  it('returns 409 when offer is already accepted', async () => {
    mockGetOffer.mockReturnValue({ ...pendingOffer, status: 'accepted', responded_at: 12345 });

    const token = makePlayerToken(PLAYER_WALLET);
    const res = await request(app).post(ACCEPT_URL).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already accepted/i);
  });

  it('returns 409 when offer is already rejected', async () => {
    mockGetOffer.mockReturnValue({ ...pendingOffer, status: 'rejected', responded_at: 99999 });

    const token = makePlayerToken(PLAYER_WALLET);
    const res = await request(app).post(ACCEPT_URL).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already rejected/i);
  });
});

// ─── POST /reject ─────────────────────────────────────────────────────────────

describe(`POST /api/players/${PLAYER_ID}/trial-offers/${OFFER_ID}/reject`, () => {
  const REJECT_URL = `/api/players/${PLAYER_ID}/trial-offers/${OFFER_ID}/reject`;

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).post(REJECT_URL);
    expect(res.status).toBe(401);
  });

  it('returns 403 when a scout JWT tries to reject', async () => {
    const token = jwt.sign({ sub: PLAYER_WALLET, role: 'scout' }, SECRET, { expiresIn: '1h' });
    const res = await request(app).post(REJECT_URL).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 403 when a different player tries to reject another player\'s offer', async () => {
    mockGetOffer.mockReturnValue(pendingOffer);
    const token = makePlayerToken(OTHER_WALLET);
    const res = await request(app).post(REJECT_URL).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when the offer does not exist', async () => {
    mockGetOffer.mockReturnValue(null);
    const token = makePlayerToken(PLAYER_WALLET);
    const res = await request(app).post(REJECT_URL).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('returns 200 with rejection recorded (no reason)', async () => {
    mockGetOffer.mockReturnValue(pendingOffer);

    const token = makePlayerToken(PLAYER_WALLET);
    const res = await request(app)
      .post(REJECT_URL)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('rejected');
    expect(res.body.data.reason).toBeNull();
    expect(res.body.data.respondedAt).toBeGreaterThan(0);

    expect(mockRespondOffer).toHaveBeenCalledWith(
      expect.objectContaining({ offer_id: OFFER_ID, status: 'rejected', reject_reason: undefined }),
    );
  });

  it('returns 200 with rejection reason included', async () => {
    mockGetOffer.mockReturnValue(pendingOffer);

    const token = makePlayerToken(PLAYER_WALLET);
    const res = await request(app)
      .post(REJECT_URL)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Not interested at this time' });

    expect(res.status).toBe(200);
    expect(res.body.data.reason).toBe('Not interested at this time');

    expect(mockRespondOffer).toHaveBeenCalledWith(
      expect.objectContaining({ reject_reason: 'Not interested at this time' }),
    );
  });

  it('returns 400 when reason exceeds 500 characters', async () => {
    mockGetOffer.mockReturnValue(pendingOffer);

    const token = makePlayerToken(PLAYER_WALLET);
    const res = await request(app)
      .post(REJECT_URL)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'x'.repeat(501) });

    expect(res.status).toBe(400);
  });

  it('returns 409 when offer is already responded to', async () => {
    mockGetOffer.mockReturnValue({ ...pendingOffer, status: 'accepted', responded_at: 11111 });

    const token = makePlayerToken(PLAYER_WALLET);
    const res = await request(app)
      .post(REJECT_URL)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(409);
  });
});
