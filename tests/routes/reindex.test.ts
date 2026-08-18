import request from 'supertest';
import app from '../../src/app';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import * as db from '../../src/db';

// Stub out the parts that admin.test.ts doesn't need to hit the real DB
jest.mock('../../src/services/audit', () => ({ logAuditEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  withdrawFees: jest.fn(),
}));

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

async function getNonAdminToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'scout' });
  return tokenRes.body.token;
}

describe('POST /api/admin/indexer/reindex', () => {
  let adminToken: string;
  let scoutToken: string;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    scoutToken = await getNonAdminToken();
  });

  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/reindex')
      .send({ fromLedger: 1000 });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/reindex')
      .set('Authorization', `Bearer ${scoutToken}`)
      .send({ fromLedger: 1000 });
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing fromLedger', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/reindex')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for negative fromLedger', async () => {
    const res = await request(app)
      .post('/api/admin/indexer/reindex')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: -1 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('resets last_ledger and returns previous value', async () => {
    // Set a known starting state
    db.persistLastIndexedLedger(9_000_000);

    const res = await request(app)
      .post('/api/admin/indexer/reindex')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 8_000_000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.fromLedger).toBe(8_000_000);
    expect(res.body.data.previous).toBe(9_000_000);
    expect(db.fetchLastIndexedLedger()).toBe(8_000_000);
  });

  it('is idempotent — calling reindex twice with the same ledger is safe', async () => {
    db.persistLastIndexedLedger(7_000_000);

    await request(app)
      .post('/api/admin/indexer/reindex')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 6_000_000 });

    const res = await request(app)
      .post('/api/admin/indexer/reindex')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fromLedger: 6_000_000 });

    expect(res.status).toBe(200);
    expect(db.fetchLastIndexedLedger()).toBe(6_000_000);
  });
});
