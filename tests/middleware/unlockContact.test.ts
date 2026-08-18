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

jest.mock('../../src/db', () => ({
  queryEvents: jest.fn(),
  insertContactUnlock: jest.fn(),
  hasContactUnlock: jest.fn().mockReturnValue(false),
  getPlayerById: jest.fn().mockReturnValue(null),
}));

import { unlockContact } from '../../src/controllers/scoutController';
import { submitContactPayment, PaymentError } from '../../src/services/stellar';
import { logger } from '../../src/utils/logger';
import * as cacheModule from '../../src/services/cache';

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

  // #763 — contact_unlocked is a player-state-changing event: after the unlock
  // row is persisted the player-list cache must be invalidated so list queries
  // reflect the change. Invalidation must NOT happen if the payment/persistence
  // fails.
  describe('cache invalidation on contact_unlocked', () => {
    it('invalidates the player-list cache only after the unlock is persisted', async () => {
      const invalidateSpy = jest
        .spyOn(cacheModule, 'invalidatePlayerCache')
        .mockResolvedValue(undefined);
      mockSubmit.mockResolvedValue({ transactionId: 'abc', status: 'submitted' });

      const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
      const res = makeRes();
      await unlockContact(req, res, next);

      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect((res.json as jest.Mock)).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
      invalidateSpy.mockRestore();
    });

    it('does not invalidate the cache when the unlock payment fails', async () => {
      const invalidateSpy = jest
        .spyOn(cacheModule, 'invalidatePlayerCache')
        .mockResolvedValue(undefined);
      mockSubmit.mockRejectedValue(new PaymentError('payment failed', 'PAYMENT_FAILED'));

      const req = { params: { wallet: WALLET, playerId: PLAYER }, account: WALLET } as unknown as Request;
      const res = makeRes();
      await unlockContact(req, res, next);

      expect(invalidateSpy).not.toHaveBeenCalled();
      expect((res.status as jest.Mock)).toHaveBeenCalledWith(402);
      invalidateSpy.mockRestore();
    });
  });
});
