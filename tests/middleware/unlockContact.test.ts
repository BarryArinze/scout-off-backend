import { Request, Response, NextFunction } from 'express';

jest.mock('../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/services/stellar', () => ({
  submitContactPayment: jest.fn(),
  PaymentError: class PaymentError extends Error {
    constructor(public message: string, public code: string) { super(message); }
  },
}));

jest.mock('../../src/db', () => ({ queryEvents: jest.fn(), insertContactUnlock: jest.fn() }));

import { unlockContact } from '../../src/controllers/scoutController';
import { submitContactPayment } from '../../src/services/stellar';
import { logger } from '../../src/utils/logger';

const mockSubmit = submitContactPayment as jest.Mock;
const mockWarn = (logger.warn as jest.Mock);
const mockInfo = (logger.info as jest.Mock);

function makeRes() {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return { status, json } as unknown as Response;
}

const next = jest.fn() as unknown as NextFunction;

describe('unlockContact', () => {
  const WALLET = 'GAE3BQINZGCGNDDFRJZYAWXDXBFJJALLZ47UCHMWASF56ILDAVUODSOR';
  const OTHER  = 'GD4LQIN4652EY3VSBTQ32PY3GVKZBKRA2PN3LUUC2TL7I53COGFLWYQP';
  const PLAYER = 'player-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 403 when JWT account does not match wallet param', async () => {
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: OTHER } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(403);
    const body = ((res.status as jest.Mock).mock.results[0].value.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/wallet/i);
  });

  it('logs a warning on denied unlock attempt', async () => {
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: OTHER } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('unlock_contact_denied')
    );
  });

  it('calls submitContactPayment when wallet ownership is verified', async () => {
    mockSubmit.mockResolvedValue({ transactionId: 'abc', status: 'submitted' });
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect(mockSubmit).toHaveBeenCalledWith(WALLET, PLAYER);
    expect((res.json as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  it('logs the unlock attempt with scout wallet when wallet matches', async () => {
    mockSubmit.mockResolvedValue({});
    const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining(WALLET)
    );
  });

  it('returns 400 when wallet param is missing', async () => {
    const req = { params: { wallet: '', playerId: PLAYER }, account: '' } as unknown as Request;
    const res = makeRes();
    await unlockContact(req, res, next);
    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
  });
});
