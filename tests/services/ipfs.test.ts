import { Request, Response, NextFunction } from 'express';

// ── shared env ────────────────────────────────────────────────────────────────
process.env.CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
process.env.JWT_SECRET = 'test-secret';

// ── mock IPFS service ─────────────────────────────────────────────────────────
const mockPinJson = jest.fn();
jest.mock('../../src/services/ipfs', () => ({
  pinJson: mockPinJson,
  gatewayUrl: (cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`,
  gatewayUrls: (cid: string) => [`https://gateway.pinata.cloud/ipfs/${cid}`],
}));

// ── mock cache service ────────────────────────────────────────────────────────
jest.mock('../../src/services/cache', () => ({
  invalidatePlayerCache: jest.fn(),
  invalidateMilestoneCache: jest.fn(),
}));

// ── mock webhooks service ─────────────────────────────────────────────────────
jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

// ── mock db (registerPlayer writes via insertOrUpdatePlayer) ──────────────────────────
jest.mock('../../src/db', () => ({
  insertOrUpdatePlayer: jest.fn(),
}));

import { registerPlayer } from '../../src/controllers/playerController';
import { submitMilestoneEvidence } from '../../src/controllers/validatorController';
import { invalidatePlayerCache } from '../../src/services/cache';
import { invalidateMilestoneCache } from '../../src/services/cache';

// ── helpers ───────────────────────────────────────────────────────────────────
function makeRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

const next = jest.fn() as NextFunction;

// ── CID format validator ──────────────────────────────────────────────────────
const CID_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Task 3 — Player registration IPFS pinning
// ─────────────────────────────────────────────────────────────────────────────
describe('registerPlayer – IPFS pinning', () => {
  const MOCK_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

  beforeEach(() => {
    jest.clearAllMocks();
    mockPinJson.mockResolvedValue(MOCK_CID);
  });

  it('calls pinJson with player metadata and returns cid + metadataUri', async () => {
    const req = {
      account: 'G'.repeat(56),
      body: {
        wallet: 'G'.repeat(56),
        position: 'striker',
        region: 'africa',
        metadata: { age: 20 },
      },
    } as Request;
    const res = makeRes();

    await registerPlayer(req, res, next);

    expect(mockPinJson).toHaveBeenCalledTimes(1);
    expect(mockPinJson).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: 'G'.repeat(56), position: 'striker', region: 'africa' })
    );
    expect(res.status).toHaveBeenCalledWith(201);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.metadataUri).toBe(MOCK_CID);
    expect(typeof body.data.gatewayUrl).toBe('string');
  });

  it('returned CID matches expected CID format', async () => {
    const req = {
      account: 'G'.repeat(56),
      body: {
        wallet: 'G'.repeat(56),
        position: 'midfielder',
        region: 'europe',
        metadata: {},
      },
    } as Request;
    const res = makeRes();

    await registerPlayer(req, res, next);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.data.metadataUri).toMatch(CID_RE);
  });

  it('calls invalidatePlayerCache after successful pin', async () => {
    const req = {
      account: 'G'.repeat(56),
      body: {
        wallet: 'G'.repeat(56),
        position: 'goalkeeper',
        region: 'asia',
        metadata: {},
      },
    } as Request;
    const res = makeRes();

    await registerPlayer(req, res, next);

    expect(invalidatePlayerCache).toHaveBeenCalledTimes(1);
  });

  it('calls next(err) when pinJson throws', async () => {
    mockPinJson.mockRejectedValue(new Error('Pinata 503'));
    const req = {
      account: 'G'.repeat(56),
      body: {
        wallet: 'G'.repeat(56),
        position: 'defender',
        region: 'south-america',
        metadata: {},
      },
    } as Request;
    const res = makeRes();
    const localNext = jest.fn();

    await registerPlayer(req, res, localNext);

    expect(localNext).toHaveBeenCalledWith(expect.any(Error));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid request body (missing wallet)', async () => {
    const req = { body: { position: 'striker', region: 'africa', metadata: {} } } as Request;
    const res = makeRes();
    const localNext = jest.fn();

    await registerPlayer(req, res, localNext);

    // zod throws → next receives the error (error handler maps to 400)
    expect(localNext).toHaveBeenCalled();
    expect(mockPinJson).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 4 — Validator evidence pinning
// ─────────────────────────────────────────────────────────────────────────────
describe('submitMilestoneEvidence – IPFS pinning', () => {
  const MOCK_CID = 'QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64';

  beforeEach(() => {
    jest.clearAllMocks();
    mockPinJson.mockResolvedValue(MOCK_CID);
  });

  it('calls pinJson with evidence payload and returns evidenceCid', async () => {
    const req = {
      body: { playerId: 'player-1', milestoneType: 'performance', evidenceUri: 'ipfs://QmTest' },
    } as Request;
    const res = makeRes();

    await submitMilestoneEvidence(req, res, next);

    expect(mockPinJson).toHaveBeenCalledWith(
      expect.objectContaining({ playerId: 'player-1', milestoneType: 'performance' })
    );
    expect(res.status).toHaveBeenCalledWith(201);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data.evidenceCid).toBe(MOCK_CID);
  });

  it('returned evidenceCid matches expected CID format', async () => {
    const req = {
      body: { playerId: 'player-2', milestoneType: 'identity', evidenceUri: 'ipfs://QmEvidence' },
    } as Request;
    const res = makeRes();

    await submitMilestoneEvidence(req, res, next);

    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.data.evidenceCid).toMatch(CID_RE);
  });

  it('calls invalidateMilestoneCache with playerId after successful pin', async () => {
    const req = {
      body: { playerId: 'player-3', milestoneType: 'trial_offer', evidenceUri: 'ipfs://QmX' },
    } as Request;
    const res = makeRes();

    await submitMilestoneEvidence(req, res, next);

    expect(invalidateMilestoneCache).toHaveBeenCalledWith('player-3');
  });

  it('calls next(err) when pinJson throws (maps to 503)', async () => {
    mockPinJson.mockRejectedValue(new Error('IPFS unavailable'));
    const req = {
      body: { playerId: 'player-1', milestoneType: 'performance', evidenceUri: 'ipfs://QmTest' },
    } as Request;
    const res = makeRes();
    const localNext = jest.fn();

    await submitMilestoneEvidence(req, res, localNext);

    expect(localNext).toHaveBeenCalledWith(expect.any(Error));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('calls next(err) for invalid payload (missing evidenceUri)', async () => {
    const req = {
      body: { playerId: 'player-1', milestoneType: 'performance' },
    } as Request;
    const res = makeRes();
    const localNext = jest.fn();

    await submitMilestoneEvidence(req, res, localNext);

    expect(localNext).toHaveBeenCalled();
    expect(mockPinJson).not.toHaveBeenCalled();
  });

  it('calls next(err) for invalid milestoneType', async () => {
    const req = {
      body: { playerId: 'player-1', milestoneType: 'unknown', evidenceUri: 'ipfs://QmTest' },
    } as Request;
    const res = makeRes();
    const localNext = jest.fn();

    await submitMilestoneEvidence(req, res, localNext);

    expect(localNext).toHaveBeenCalled();
    expect(mockPinJson).not.toHaveBeenCalled();
  });
});
