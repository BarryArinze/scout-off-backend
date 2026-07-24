/**
 * #303 — validateBody middleware on POST /scouts/:wallet/contacts/:playerId/unlock
 *
 * Verifies:
 *  - Unexpected body fields cause a 400 (strict schema)
 *  - Empty body (normal case) still works end-to-end (existing functionality unaffected)
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';
const WALLET = 'GAEW6VQNHJ45XOB5IBZVI2HLJGXPEM5JEKB5XR3CVAUGDNVATCW36GU4';
const PLAYER_ID = 'player-unlock-303';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn().mockReturnValue(null),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn().mockReturnValue(1),
  insertContactUnlock: jest.fn(),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  submitContactPayment: jest.fn().mockResolvedValue({ txHash: 'stub-unlock-tx' }),
  isSubscribed: jest.fn().mockResolvedValue(true),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn(),
  gatewayUrl: jest.fn(),
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

function makeToken(wallet: string, role: string) {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

describe('#303 POST /api/scouts/:wallet/contacts/:playerId/unlock — body validation', () => {
  it('returns 400 when unexpected fields are sent in the body', async () => {
    const token = makeToken(WALLET, 'scout');
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}/unlock`)
      .set('Authorization', `Bearer ${token}`)
      .send({ unexpectedField: 'should-be-rejected' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('proceeds normally with an empty body (existing unlock functionality unaffected)', async () => {
    const token = makeToken(WALLET, 'scout');
    const res = await request(app)
      .post(`/api/scouts/${WALLET}/contacts/${PLAYER_ID}/unlock`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    // Not 400 — validation passed; controller handles the rest.
    expect(res.status).not.toBe(400);
  });
});
