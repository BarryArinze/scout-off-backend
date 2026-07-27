import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import app from '../../src/app';

async function getAuthToken(role: string): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role });
  return tokenRes.body.token;
}

describe('Admin query schema date filtering (#30)', () => {
  let token: string;

  beforeAll(async () => {
    token = await getAuthToken('admin');
  });

  describe('GET /api/admin/events', () => {
    it('returns 200 with no query params', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 200 with valid ISO startDate and endDate', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ startDate: '2024-01-01T00:00:00.000Z', endDate: '2025-12-31T00:00:00.000Z' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('returns 400 for invalid startDate format', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ startDate: 'not-a-date' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('startDate');
    });

    it('returns 400 for invalid endDate format', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ endDate: '31-12-2024' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('endDate');
    });

    it('returns 400 when startDate is after endDate', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ startDate: '2025-12-01T00:00:00.000Z', endDate: '2024-01-01T00:00:00.000Z' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].message).toContain('startDate must not be after endDate');
    });
  });

  describe('GET /api/admin/fees', () => {
    it('returns 200 with no query params', async () => {
      const res = await request(app)
        .get('/api/admin/fees')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('returns 400 for invalid startDate on /fees', async () => {
      const res = await request(app)
        .get('/api/admin/fees')
        .query({ startDate: 'bad-date' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('startDate');
    });
  });

  describe('GET /api/admin/events - ledger range validation', () => {
    it('returns 400 for invalid fromLedger (non-numeric)', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ fromLedger: 'abc' })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('fromLedger');
    });

    it('returns 400 for invalid toLedger (negative)', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ toLedger: -1 })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('toLedger');
    });

    it('returns 400 when fromLedger > toLedger', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ fromLedger: 100, toLedger: 50 })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].message).toContain('fromLedger must not be greater than toLedger');
    });
  });

  describe('GET /api/admin/events - pagination validation', () => {
    it('returns 400 for invalid page (negative)', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ page: -1 })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('page');
    });

    it('returns 400 for invalid pageSize (exceeds max)', async () => {
      const res = await request(app)
        .get('/api/admin/events')
        .query({ pageSize: 101 })
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('pageSize');
    });
  });

  describe('POST /api/admin/indexer/reindex - fromLedger validation', () => {
    it('returns 400 for invalid fromLedger (string)', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/reindex')
        .set('Authorization', `Bearer ${token}`)
        .send({ fromLedger: 'abc' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('fromLedger');
    });

    it('returns 400 for invalid fromLedger (negative)', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/reindex')
        .set('Authorization', `Bearer ${token}`)
        .send({ fromLedger: -1 });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('fromLedger');
    });

    it('returns 200 for valid fromLedger', async () => {
      const res = await request(app)
        .post('/api/admin/indexer/reindex')
        .set('Authorization', `Bearer ${token}`)
        .send({ fromLedger: 100 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/admin/validators/register - wallet validation', () => {
    it('returns 400 for invalid wallet address', async () => {
      const res = await request(app)
        .post('/api/admin/validators/register')
        .set('Authorization', `Bearer ${token}`)
        .send({ validatorWallet: 'INVALID' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('validatorWallet');
      expect(res.body.details[0].message).toBe('Invalid Stellar address');
    });

    it('returns 202 for valid wallet address', async () => {
      const validWallet = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const res = await request(app)
        .post('/api/admin/validators/register')
        .set('Authorization', `Bearer ${token}`)
        .send({ validatorWallet: validWallet });
      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/admin/fees - recipient validation', () => {
    it('returns 400 for invalid recipient address', async () => {
      const res = await request(app)
        .post('/api/admin/fees')
        .set('Authorization', `Bearer ${token}`)
        .send({ recipient: 'INVALID' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Validation Error');
      expect(res.body.details).toBeDefined();
      expect(res.body.details[0].field).toBe('recipient');
      expect(res.body.details[0].message).toBe('Invalid Stellar address');
    });
  });
});
