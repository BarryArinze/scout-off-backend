import request from 'supertest';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';

// This file exercises the real indexer/DB layer end-to-end, but
// register_validator/revoke_validator now perform a real Soroban RPC
// round-trip in production. Mock only those two functions (keeping
// everything else — indexer, audit, DB — real) so these route-level tests
// stay deterministic and offline, matching how contract.test.ts mocks
// unpauseContractOnChain for the same reason.
jest.mock('../../src/services/stellar', () => ({
  ...jest.requireActual('../../src/services/stellar'),
  registerValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'e2e-register-txid' }),
  revokeValidatorOnChain: jest.fn().mockResolvedValue({ transactionId: 'e2e-revoke-txid' }),
}));

import app from '../../src/app';

async function getToken(role: string): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role });
  return tokenRes.body.token;
}

const VALID_WALLET = Keypair.random().publicKey();

// ─── Security headers ─────────────────────────────────────────────────────────

describe('Security headers', () => {
  it('sets required security headers on all responses', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBeDefined();
  });

  it('sets helmet cross-origin headers on all responses', async () => {
    const res = await request(app).get('/health');
    // Helmet-provided headers absent from the custom middleware
    expect(res.headers['cross-origin-opener-policy']).toBeDefined();
    expect(res.headers['cross-origin-resource-policy']).toBeDefined();
    expect(res.headers['x-permitted-cross-domain-policies']).toBeDefined();
    expect(res.headers['x-dns-prefetch-control']).toBeDefined();
  });

  it('does not expose x-powered-by header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

// ─── Admin validator registry ─────────────────────────────────────────────────

describe('POST /api/admin/validators/register', () => {
  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post('/api/admin/validators/register')
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getToken('validator');
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid wallet address', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: 'NOTAVALIDADDRESS' });
    expect(res.status).toBe(400);
  });

  it('returns 202 with a transactionId for valid admin request', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.transactionId).toBe('e2e-register-txid');
  });

  it('does not insert the local row and returns an error status when the chain call fails', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();

    const { registerValidatorOnChain, ValidatorActionError } = jest.requireMock('../../src/services/stellar') as {
      registerValidatorOnChain: jest.Mock;
      ValidatorActionError: new (msg: string, code: string) => Error & { code: string };
    };
    registerValidatorOnChain.mockRejectedValueOnce(
      new ValidatorActionError('Simulation failed: rpc down', 'NETWORK_ERROR'),
    );

    const res = await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.success).toBe(false);

    const listRes = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    const found = listRes.body.data.find((v: { wallet: string }) => v.wallet === wallet);
    expect(found).toBeUndefined();

    // restore default success behaviour for subsequent tests
    registerValidatorOnChain.mockResolvedValue({ transactionId: 'e2e-register-txid' });
  });
});

describe('POST /api/admin/validators/revoke', () => {
  it('returns 401 with no token', async () => {
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getToken('scout');
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(403);
  });

  it('returns 202 with a transactionId for valid admin request', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.transactionId).toBe('e2e-revoke-txid');
  });

  it('returns 409 without calling the chain when the wallet is already revoked locally', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();

    await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    const first = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    expect(first.status).toBe(202);

    const { revokeValidatorOnChain } = jest.requireMock('../../src/services/stellar') as {
      revokeValidatorOnChain: jest.Mock;
    };
    revokeValidatorOnChain.mockClear();

    const second = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);
    expect(revokeValidatorOnChain).not.toHaveBeenCalled();
  });

  it('does not update the local row and returns an error status when the chain call fails', async () => {
    const token = await getToken('admin');
    const wallet = Keypair.random().publicKey();

    await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });

    const { revokeValidatorOnChain, ValidatorActionError } = jest.requireMock('../../src/services/stellar') as {
      revokeValidatorOnChain: jest.Mock;
      ValidatorActionError: new (msg: string, code: string) => Error & { code: string };
    };
    revokeValidatorOnChain.mockRejectedValueOnce(
      new ValidatorActionError('Simulation failed: rpc down', 'NETWORK_ERROR'),
    );

    const res = await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: wallet });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.success).toBe(false);

    const listRes = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    const found = listRes.body.data.find((v: { wallet: string }) => v.wallet === wallet);
    expect(found).toBeDefined();
    expect(found.revoked_at).toBeNull();

    // restore default success behaviour for subsequent tests
    revokeValidatorOnChain.mockResolvedValue({ transactionId: 'e2e-revoke-txid' });
  });
});

describe('GET /api/admin/validators', () => {
  it('returns 401 with no token', async () => {
    const res = await request(app).get('/api/admin/validators');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin role', async () => {
    const token = await getToken('scout');
    const res = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 with a data array for admin', async () => {
    const token = await getToken('admin');
    const res = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('includes a registered validator after registration', async () => {
    const token = await getToken('admin');
    // Register first
    await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    // Then list
    const res = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const found = res.body.data.find((v: { wallet: string }) => v.wallet === VALID_WALLET);
    expect(found).toBeDefined();
    expect(found.registered_at).toBeGreaterThan(0);
    expect(found.revoked_at).toBeNull();
  });

  it('marks a validator as revoked after revocation', async () => {
    const token = await getToken('admin');
    // Register then revoke
    await request(app)
      .post('/api/admin/validators/register')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    await request(app)
      .post('/api/admin/validators/revoke')
      .set('Authorization', `Bearer ${token}`)
      .send({ validatorWallet: VALID_WALLET });
    const res = await request(app)
      .get('/api/admin/validators')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const found = res.body.data.find((v: { wallet: string }) => v.wallet === VALID_WALLET);
    expect(found).toBeDefined();
    expect(found.revoked_at).not.toBeNull();
  });
});
