import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';

const SECRET = process.env.JWT_SECRET ?? 'test-secret';

jest.mock('../../src/services/ipfs', () => ({
  pinJson: jest.fn().mockResolvedValue('QmTestCid123'),
}));

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
  getPendingMilestones: jest.fn(),
  // src/utils/audit.ts's recordAudit (called from validatorController's
  // submitMilestoneEvidence and getPendingMilestones) calls this directly.
  insertAuditLog: jest.fn().mockResolvedValue({
    id: 1,
    action: 'mock',
    admin_wallet: '',
    query_params: '{}',
    created_at: new Date().toISOString(),
    prev_hash: null,
    hash: 'mock-hash',
    event_source: 'app_event',
  }),
}));

jest.mock('../../src/services/indexer', () => ({
  indexEvents: jest.fn(),
  normalizeEventId: jest.fn(),
}));

jest.mock('../../src/services/cache', () => ({
  invalidateMilestoneCache: jest.fn(),
}));

import { queryEvents, getPendingMilestones } from '../../src/db';
const mockGetEvents = queryEvents as jest.Mock;
const mockGetPendingMilestones = getPendingMilestones as jest.Mock;

function makeToken(wallet: string, role: string): string {
  return jwt.sign({ sub: wallet, role }, SECRET, { expiresIn: '1h' });
}

const VALIDATOR_WALLET = 'GVALIDATOR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PLAYER_WALLET = 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SCOUT_WALLET = 'GSCOUT1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ADMIN_WALLET = 'GADMIN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  mockGetEvents.mockReset();
  mockGetPendingMilestones.mockReset();
  mockGetPendingMilestones.mockReturnValue({ data: [], total: 0 });
});

// ─── POST /api/validators/milestone ───────────────────────────────────────────

describe('POST /api/validators/milestone', () => {
  const validPayload = {
    playerId: 'player-123',
    milestoneType: 'performance',
    evidenceUri: 'ipfs://QmEvidenceCid',
  };

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).post('/api/validators/milestone').send(validPayload);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when user is authenticated but not a validator', async () => {
    const playerToken = makeToken(PLAYER_WALLET, 'player');
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${playerToken}`)
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 403 when user is a scout', async () => {
    const scoutToken = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${scoutToken}`)
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 403 when user is an admin', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(validPayload);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 201 when user is a validator with valid payload', async () => {
    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${validatorToken}`)
      .send(validPayload);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.evidenceCid).toBe('QmTestCid123');
  });

  it('returns 400 when payload is invalid', async () => {
    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .post('/api/validators/milestone')
      .set('Authorization', `Bearer ${validatorToken}`)
      .send({ playerId: 'player-123' }); // missing required fields
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/validators/milestones/pending ───────────────────────────────────

describe('GET /api/validators/milestones/pending', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/api/validators/milestones/pending');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 403 when user is authenticated but not a validator', async () => {
    const playerToken = makeToken(PLAYER_WALLET, 'player');
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 403 when user is a scout', async () => {
    const scoutToken = makeToken(SCOUT_WALLET, 'scout');
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${scoutToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 403 when user is an admin', async () => {
    const adminToken = makeToken(ADMIN_WALLET, 'admin');
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Insufficient permissions');
  });

  it('returns 200 with empty array when validator has no pending milestones', async () => {
    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${validatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('returns 200 with pending milestones for validator', async () => {
    const submittedAt = Math.floor(Date.now() / 1000);
    mockGetPendingMilestones.mockReturnValue({
      data: [
        {
          milestone_id: 'm1',
          player_id: 'player-1',
          validator_wallet: VALIDATOR_WALLET,
          milestone_type: 'performance',
          evidence_uri: 'QmEvidence1',
          submitted_at: submittedAt,
        },
      ],
      total: 1,
    });

    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get('/api/validators/milestones/pending')
      .set('Authorization', `Bearer ${validatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      evidenceUri: 'QmEvidence1',
    });
  });

  it('filters pending milestones by region query parameter', async () => {
    const submittedAt = Math.floor(Date.now() / 1000);
    mockGetPendingMilestones.mockReturnValue({
      data: [
        {
          milestone_id: 'm1',
          player_id: 'player-1',
          validator_wallet: VALIDATOR_WALLET,
          milestone_type: 'performance',
          evidence_uri: 'QmEvidence1',
          submitted_at: submittedAt,
        },
      ],
      total: 1,
    });

    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get('/api/validators/milestones/pending?region=EU')
      .set('Authorization', `Bearer ${validatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].evidenceUri).toBe('QmEvidence1');
    expect(mockGetPendingMilestones).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'EU' })
    );
  });

  it('filters pending milestones by playerId query parameter', async () => {
    const submittedAt = Math.floor(Date.now() / 1000);
    mockGetPendingMilestones.mockReturnValue({
      data: [
        {
          milestone_id: 'm1',
          player_id: 'player-1',
          validator_wallet: VALIDATOR_WALLET,
          milestone_type: 'performance',
          evidence_uri: 'QmEvidence1',
          submitted_at: submittedAt,
        },
      ],
      total: 1,
    });

    const validatorToken = makeToken(VALIDATOR_WALLET, 'validator');
    const res = await request(app)
      .get('/api/validators/milestones/pending?playerId=player-1')
      .set('Authorization', `Bearer ${validatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].evidenceUri).toBe('QmEvidence1');
    expect(mockGetPendingMilestones).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 'player-1' })
    );
  });
});
