import request from 'supertest';
import app from '../../src/app';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import { isValidEvidenceUri } from '../../src/controllers/validatorController';

async function getValidatorToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'validator' });
  return tokenRes.body.token;
}

describe('isValidEvidenceUri helper', () => {
  it('accepts ipfs:// URIs', () => {
    expect(isValidEvidenceUri('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true);
  });

  it('accepts https:// URIs', () => {
    expect(isValidEvidenceUri('https://example.com/evidence.json')).toBe(true);
  });

  it('rejects http:// URIs', () => {
    expect(isValidEvidenceUri('http://example.com/evidence')).toBe(false);
  });

  it('rejects plain strings', () => {
    expect(isValidEvidenceUri('not-a-uri')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidEvidenceUri('')).toBe(false);
  });

  it('rejects bare scheme prefixes with no content', () => {
    expect(isValidEvidenceUri('https://')).toBe(false);
    expect(isValidEvidenceUri('ipfs://')).toBe(false);
  });
});

describe('POST /api/validators/milestone - evidenceUri validation', () => {
  it('returns 400 for http:// URI', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: 'http://example.com/evidence' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 for plain string URI', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: 'not-a-uri' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('accepts ipfs:// URI', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: 'ipfs://QmYwAPJzv5CZsnA' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('accepts https:// URI', async () => {
    const token = await getValidatorToken();
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerId: 'player-1', milestoneType: 'identity', evidenceUri: 'https://evidence.example.com/doc.json' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});
