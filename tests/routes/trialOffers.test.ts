import request from 'supertest';
import app from '../../src/app';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import { insertTrialOffer, getTrialOffers } from '../../src/services/indexer';

// Mock invokeContract so tests don't hit real Soroban
jest.mock('../../src/utils/contract', () => ({
  ...jest.requireActual('../../src/utils/contract'),
  invokeContract: jest.fn().mockResolvedValue({
    hash: 'mock-tx-hash-trial-offer-test',
    returnValue: {},
  }),
  strVal: jest.fn((s: string) => s),
}));

async function getScoutToken(): Promise<string> {
  const kp = Keypair.random();
  const challengeRes = await request(app).get(`/auth/challenge?account=${kp.publicKey()}`);
  const tx = new Transaction(challengeRes.body.challenge, Networks.TESTNET);
  tx.sign(kp);
  const tokenRes = await request(app)
    .post('/auth/token')
    .send({ transaction: tx.toXDR(), role: 'scout' });
  return tokenRes.body.token;
}

const SCOUT_WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

describe('#285 trial_offers', () => {
  describe('insertTrialOffer + getTrialOffers (DB layer)', () => {
    it('persists an offer and retrieves it by scout wallet', () => {
      const now = Math.floor(Date.now() / 1000);
      insertTrialOffer(SCOUT_WALLET, 'player-1', 'ipfs://QmTest', 'tx-hash-1', now);

      const offers = getTrialOffers(SCOUT_WALLET);
      expect(offers.length).toBeGreaterThanOrEqual(1);

      const offer = offers.find((o) => o.tx_hash === 'tx-hash-1');
      expect(offer).toBeDefined();
      expect(offer!.scout_wallet).toBe(SCOUT_WALLET);
      expect(offer!.player_id).toBe('player-1');
      expect(offer!.details_uri).toBe('ipfs://QmTest');
      expect(offer!.created_at).toBe(now);
    });

    it('does not insert duplicate tx_hash', () => {
      const now = Math.floor(Date.now() / 1000);
      insertTrialOffer(SCOUT_WALLET, 'player-2', 'ipfs://QmDup', 'tx-dup', now);
      insertTrialOffer(SCOUT_WALLET, 'player-2', 'ipfs://QmDup', 'tx-dup', now);

      const offers = getTrialOffers(SCOUT_WALLET).filter((o) => o.tx_hash === 'tx-dup');
      expect(offers.length).toBe(1);
    });
  });

  describe('GET /api/scouts/:wallet/trial-offers', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app).get(`/api/scouts/${SCOUT_WALLET}/trial-offers`);
      expect(res.status).toBe(401);
    });

    it('returns offer list for authenticated scout', async () => {
      // Pre-seed an offer
      insertTrialOffer(SCOUT_WALLET, 'player-3', 'ipfs://QmGet', 'tx-get-test', Math.floor(Date.now() / 1000));

      const token = await getScoutToken();
      const res = await request(app)
        .get(`/api/scouts/${SCOUT_WALLET}/trial-offers`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  describe('POST /api/scouts/:wallet/trial-offers', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post(`/api/scouts/${SCOUT_WALLET}/trial-offers`)
        .send({ playerId: 'player-1', detailsUri: 'ipfs://QmX' });
      expect(res.status).toBe(401);
    });

    it('returns 400 for missing fields', async () => {
      const token = await getScoutToken();
      const res = await request(app)
        .post(`/api/scouts/${SCOUT_WALLET}/trial-offers`)
        .set('Authorization', `Bearer ${token}`)
        .send({ playerId: '' });
      expect(res.status).toBe(400);
    });

    it('inserts offer and returns 201 with transactionId', async () => {
      const token = await getScoutToken();
      const res = await request(app)
        .post(`/api/scouts/${SCOUT_WALLET}/trial-offers`)
        .set('Authorization', `Bearer ${token}`)
        .send({ playerId: 'player-99', detailsUri: 'ipfs://QmPost' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.transactionId).toBe('mock-tx-hash-trial-offer-test');

      // Verify persisted
      const stored = getTrialOffers(SCOUT_WALLET).find(
        (o) => o.tx_hash === 'mock-tx-hash-trial-offer-test'
      );
      expect(stored).toBeDefined();
      expect(stored!.player_id).toBe('player-99');
    });
  });
});
