/**
 * End-to-end test for the complete SEP-10 authentication flow:
 * 1. GET /auth/challenge → receive challenge XDR
 * 2. Sign challenge with test Stellar keypair
 * 3. POST /auth/token → receive JWT
 * 4. Use JWT on a protected endpoint
 */

import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import app from '../../src/app';

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn().mockReturnValue([]),
  getPlayerById: jest.fn().mockReturnValue(null),
  queryPlayers: jest.fn().mockReturnValue([]),
  countPlayers: jest.fn().mockReturnValue(0),
  getEventsCount: jest.fn().mockReturnValue(0),
  fetchLastIndexedLedger: jest.fn().mockReturnValue(0),
  persistLastIndexedLedger: jest.fn(),
  insertOrUpdatePlayer: jest.fn(),
  insertPlayerProfileHistory: jest.fn(),
  getPlayerProfileHistory: jest.fn().mockReturnValue([]),
  getLatestSubscription: jest.fn().mockReturnValue(null),
  insertSubscription: jest.fn(),
  getContactUnlocksByScout: jest.fn().mockReturnValue([]),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  insertContactUnlock: jest.fn(),
}));

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
  checkHealth: jest.fn().mockResolvedValue(undefined),
  gatewayUrl: jest.fn((cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/stellar', () => ({
  stellarHealth: jest.fn().mockResolvedValue(true),
  queryMilestones: jest.fn().mockResolvedValue([]),
  updateProfile: jest.fn(),
  submitContactPayment: jest.fn(),
  isSubscribed: jest.fn().mockResolvedValue({ active: false, expiresAt: null }),
  purchaseSubscription: jest.fn(),
  renewSubscription: jest.fn(),
  cancelSubscriptionOnChain: jest.fn(),
  logTrialOffer: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

const TEST_KEYPAIR = Keypair.random();
const NETWORK = Networks.TESTNET;

describe('E2E SEP-10 Authentication Flow', () => {
  it('completes the full challenge → sign → token → protected-route handshake', async () => {
    // Step 1: GET /auth/challenge
    const challengeRes = await request(app)
      .get('/auth/challenge')
      .query({ account: TEST_KEYPAIR.publicKey() });

    expect(challengeRes.status).toBe(200);
    expect(challengeRes.body.challenge).toBeDefined();
    expect(typeof challengeRes.body.challenge).toBe('string');
    expect(challengeRes.body.networkPassphrase).toBeDefined();

    // Step 2: Sign the challenge with the test keypair
    const challengeXdr = challengeRes.body.challenge;
    const tx = new Transaction(challengeXdr, NETWORK);
    tx.sign(TEST_KEYPAIR);
    const signedXdr = tx.toXDR();

    // Step 3: POST /auth/token
    const tokenRes = await request(app)
      .post('/auth/token')
      .send({ transaction: signedXdr });

    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.token).toBeDefined();
    expect(typeof tokenRes.body.token).toBe('string');
    expect(tokenRes.body.account).toBe(TEST_KEYPAIR.publicKey());
    expect(tokenRes.body.expiresAt).toBeDefined();

    const jwt = tokenRes.body.token;

    // Step 4: Use JWT on a protected endpoint (GET /api/players — optionalAuth)
    const protectedRes = await request(app)
      .get('/api/players')
      .set('Authorization', `Bearer ${jwt}`);

    expect(protectedRes.status).toBe(200);
    expect(protectedRes.body.success).toBe(true);
  });

  it('rejects an unsigned challenge at POST /auth/token', async () => {
    const challengeRes = await request(app)
      .get('/auth/challenge')
      .query({ account: TEST_KEYPAIR.publicKey() });

    expect(challengeRes.status).toBe(200);

    // Don't sign — submit the challenge as-is
    const tokenRes = await request(app)
      .post('/auth/token')
      .send({ transaction: challengeRes.body.challenge });

    expect(tokenRes.status).toBe(401);
    expect(tokenRes.body.success).toBe(false);
    expect(tokenRes.body.error).toMatch(/signature/i);
  });

  it('rejects a challenge signed by the wrong keypair', async () => {
    const wrongKeypair = Keypair.random();

    const challengeRes = await request(app)
      .get('/auth/challenge')
      .query({ account: TEST_KEYPAIR.publicKey() });

    expect(challengeRes.status).toBe(200);

    const tx = new Transaction(challengeRes.body.challenge, NETWORK);
    tx.sign(wrongKeypair);
    const signedXdr = tx.toXDR();

    const tokenRes = await request(app)
      .post('/auth/token')
      .send({ transaction: signedXdr });

    expect(tokenRes.status).toBe(401);
    expect(tokenRes.body.success).toBe(false);
  });

  it('issues a JWT with a requested role', async () => {
    const challengeRes = await request(app)
      .get('/auth/challenge')
      .query({ account: TEST_KEYPAIR.publicKey() });

    const tx = new Transaction(challengeRes.body.challenge, NETWORK);
    tx.sign(TEST_KEYPAIR);
    const signedXdr = tx.toXDR();

    const tokenRes = await request(app)
      .post('/auth/token')
      .send({ transaction: signedXdr, role: 'scout' });

    expect(tokenRes.status).toBe(200);
    expect(tokenRes.body.token).toBeDefined();

    // Verify the JWT grants access to scout-only routes
    const scoutRes = await request(app)
      .get(`/api/scouts/${TEST_KEYPAIR.publicKey()}/payments`)
      .set('Authorization', `Bearer ${tokenRes.body.token}`);

    expect(scoutRes.status).toBe(200);
    expect(scoutRes.body.success).toBe(true);
  });
});
