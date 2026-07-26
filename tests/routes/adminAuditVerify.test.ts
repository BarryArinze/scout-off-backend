import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import app from '../../src/app';
import * as db from '../../src/db';

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

describe('GET /api/admin/audit/verify (#464)', () => {
  beforeEach(() => {
    db.getDb().prepare('DELETE FROM audit_log').run();
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/admin/audit/verify');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getNonAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('reports a valid chain for an admin caller', async () => {
    db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    db.insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });

    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.brokenAtId).toBeNull();
    expect(res.body.data.rowsChecked).toBe(2);
  });

  it('reports the broken row id after a row is tampered with', async () => {
    db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });
    const second = db.insertAuditLog({ action: 'contract_state_change', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-02T00:00:00.000Z' });

    db.getDb().prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('tampered', second.id);

    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit/verify')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.brokenAtId).toBe(second.id);
  });
});

describe('GET /api/admin/audit — includes hash chain columns', () => {
  beforeEach(() => {
    db.getDb().prepare('DELETE FROM audit_log').run();
  });

  it('returns hash/prev_hash/event_source alongside each row', async () => {
    db.insertAuditLog({ action: 'fee_history_query', adminWallet: 'GADMIN1', queryParams: {}, createdAt: '2025-01-01T00:00:00.000Z' });

    const token = await getAdminToken();
    const res = await request(app)
      .get('/api/admin/audit')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(typeof res.body.data[0].hash).toBe('string');
    expect(res.body.data[0].hash).toHaveLength(64);
    expect(res.body.data[0].prev_hash).toBeDefined();
    expect(res.body.data[0].event_source).toBe('admin_action');
  });
});
