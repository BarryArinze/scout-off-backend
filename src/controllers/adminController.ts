import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { getEvents, getLastLedger, setLastLedger, getValidatorStats, getWebhookDeliveries, getWebhookDeliverySummary } from '../db';
import { ApiResponse, EventRecord } from '../types';
import { logAuditEvent } from '../services/audit';
import { withdrawFees as stellarWithdrawFees, FeeWithdrawalError, FeeWithdrawalResult } from '../services/stellar';
import config from '../config';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import type { Request, Response, NextFunction } from 'express';

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/** GET /api/admin/stats */
export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: {
        players: getEvents('player_registered').length,
        milestones: getEvents('milestone_approved').length,
        subscriptions: getEvents('scout_subscribed').length,
        events: getEvents().length,
      },
    });
  } catch (err) {
    next(err);
  }
}

const isoDateString = z
  .string()
  .refine((v) => !isNaN(Date.parse(v)), { message: 'Must be a valid ISO 8601 date string' })
  .transform((v) => new Date(v));

const auditQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** GET /api/admin/audit */
export async function getAuditLog(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid query parameters' });
      return;
    }
    const { startDate, endDate, action, limit, offset } = parsed.data;
    const rows = getAuditLogs({ action, startDate, endDate, limit, offset });
    const total = getAuditLogsCount({ action, startDate, endDate });
    res.json({
      success: true,
      data: rows.map((r) => ({ ...r, query_params: JSON.parse(r.query_params) })),
      total,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
}

/** Exported so routes can apply validateQuery(adminDateRangeSchema) */
export const adminDateRangeSchema = z.object({
  startDate: isoDateString.optional(),
  endDate: isoDateString.optional(),
  eventType: z.string().optional(),
}).refine(
  (d) => !(d.startDate && d.endDate && d.startDate > d.endDate),
  { message: 'startDate must not be after endDate' }
);

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /api/admin/events */
export async function getAllEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const dateResult = adminDateRangeSchema.safeParse(req.query);
    if (!dateResult.success) {
      res.status(400).json({ success: false, error: dateResult.error.errors[0]?.message ?? 'Invalid query parameters', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const pageResult = paginationSchema.safeParse(req.query);
    if (!pageResult.success) {
      res.status(400).json({ success: false, error: pageResult.error.errors[0]?.message ?? 'Invalid pagination parameters', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const { startDate, endDate, eventType } = dateResult.data;
    const { limit: requestedLimit, offset: requestedOffset, page, pageSize } = pageResult.data;
    const limit = requestedLimit ?? pageSize ?? 20;
    const offset = requestedOffset ?? ((page ?? 1) - 1) * limit;

    const eventTypeFilter = eventType as ContractEventType | undefined;
    let events = getEvents(eventTypeFilter, { limit, offset }) as unknown as EventRecord[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (startDate) events = events.filter((e: any) => new Date(e.timestamp ?? e.created_at ?? 0) >= startDate!);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (endDate) events = events.filter((e: any) => new Date(e.timestamp ?? e.created_at ?? 0) <= endDate!);

    const total = getEventsCount(eventTypeFilter);
    res.json({ success: true, data: events, total, limit, offset });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/fees — returns fees_withdrawn event payloads */
export async function getFeeSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const dateResult = adminDateRangeSchema.safeParse(req.query);
    if (!dateResult.success) {
      res.status(400).json({ success: false, error: dateResult.error.errors[0]?.message ?? 'Invalid query parameters', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const adminWallet = req.account ?? 'unknown';
    logAuditEvent({
      action: 'fee_history_query',
      adminWallet,
      queryParams: req.query as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
    const withdrawals = getEvents('fees_withdrawn').map((e) => e.payload as Record<string, unknown>);
    const body: ApiResponse<Record<string, unknown>[]> = { success: true, data: withdrawals };
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/validators/register */
export async function registerValidator(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    const { validatorWallet } = req.body as { validatorWallet?: string };

    if (!validatorWallet || !STELLAR_ADDRESS_RE.test(validatorWallet)) {
      logger.warn(`[admin] register_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`);
      res.status(400).json({ success: false, error: 'validatorWallet must be a valid Stellar address', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    logger.info(`[admin] action=register_validator admin=${adminWallet} target=${validatorWallet}`);
    // TODO: invoke register_validator on Soroban contract
    res.status(202).json({ success: true, message: `Validator ${validatorWallet} registration submitted` });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/validators/revoke */
export async function revokeValidator(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    const { validatorWallet } = req.body as { validatorWallet?: string };

    if (!validatorWallet || !STELLAR_ADDRESS_RE.test(validatorWallet)) {
      logger.warn(`[admin] revoke_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`);
      res.status(400).json({ success: false, error: 'validatorWallet must be a valid Stellar address', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    logger.info(`[admin] action=revoke_validator admin=${adminWallet} target=${validatorWallet}`);
    // TODO: invoke revoke_validator on Soroban contract
    res.status(202).json({ success: true, message: `Validator ${validatorWallet} revocation submitted` });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/contract/pause
 * Stub: signals intent to pause the Soroban contract. Contract-level behavior is simulated.
 */
export async function pauseContract(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    // Check if admin wallet is in allowed admin wallets
    if (!config.adminWallets.includes(adminWallet)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }
    // Check threshold for high-value operations
    if (config.adminThreshold > 1) {
      // TODO: Implement multi-signature collection and verification
      res.status(403).json({ success: false, error: 'High-value operation requires multiple admin signatures' });
      return;
    }
    logAuditEvent({
      action: 'contract_state_change',
      adminWallet,
      queryParams: {},
      timestamp: new Date().toISOString(),
      contractAction: 'pause_contract',
    });
    // NOTE: Contract-level pause is simulated. Real invocation will call pause() on the Soroban contract.
    res.status(202).json({
      success: true,
      message: 'Contract pause submitted (simulated)',
      transactionId: 'stub-pause-txn-placeholder',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/contract/unpause
 * Stub: signals intent to unpause the Soroban contract. Contract-level behavior is simulated.
 */
export async function unpauseContract(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    // Check if admin wallet is in allowed admin wallets
    if (!config.adminWallets.includes(adminWallet)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }
    // Check threshold for high-value operations
    if (config.adminThreshold > 1) {
      // TODO: Implement multi-signature collection and verification
      res.status(403).json({ success: false, error: 'High-value operation requires multiple admin signatures' });
      return;
    }
    logAuditEvent({
      action: 'contract_state_change',
      adminWallet,
      queryParams: {},
      timestamp: new Date().toISOString(),
      contractAction: 'unpause_contract',
    });
    // NOTE: Contract-level unpause is simulated. Real invocation will call unpause() on the Soroban contract.
    res.status(202).json({
      success: true,
      message: 'Contract unpause submitted (simulated)',
      transactionId: 'stub-unpause-txn-placeholder',
    });
  } catch (err) {
    next(err);
  }
}

const introspectSchema = z.object({
  token: z.string().min(1, 'token is required'),
});

/** POST /api/admin/introspect */
export async function introspectToken(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = introspectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message, code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(parsed.data.token, config.jwtSecret) as jwt.JwtPayload;
    } catch {
      res.status(400).json({ success: false, error: 'Invalid or expired token', code: ErrorCode.TOKEN_INVALID });
      return;
    }

    // Return only non-secret metadata fields
    res.json({
      success: true,
      data: {
        sub: payload.sub,
        role: payload.role,
        iat: payload.iat,
        exp: payload.exp,
      },
    });
  } catch (err) {
    next(err);
  }
}

const STELLAR_ADDRESS_RE_PUBLIC = /^G[A-Z2-7]{55}$/;

export const withdrawFeesSchema = z.object({
  recipient: z
    .string()
    .regex(STELLAR_ADDRESS_RE_PUBLIC, 'recipient must be a valid Stellar public key'),
});

/**
 * In-process mutex: prevents concurrent fee withdrawals.
 * A withdrawal in-flight sets this to true; cleared after the call settles.
 */
let withdrawalInProgress = false;

/** Exposed for tests to reset between runs. */
export function resetWithdrawalLock(): void {
  withdrawalInProgress = false;
}

/** Exposed for tests to simulate a lock already being held. */
export function setWithdrawalLockForTesting(): void {
  withdrawalInProgress = true;
}

/** POST /api/admin/fees — withdraw accumulated platform fees */
export async function withdrawFeesController(req: Request, res: Response, next: NextFunction) {
  // Controller-level role guard (defence-in-depth in addition to the route middleware).
  if (req.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Insufficient permissions', code: ErrorCode.FORBIDDEN });
    return;
  }

  const adminWallet = req.account ?? 'unknown';
  // Check if admin wallet is in allowed admin wallets
  if (!config.adminWallets.includes(adminWallet)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions' });
    return;
  }
  // Check threshold for high-value operations
  if (config.adminThreshold > 1) {
    // TODO: Implement multi-signature collection and verification
    res.status(403).json({ success: false, error: 'High-value operation requires multiple admin signatures' });
    return;
  }
  const parsed = withdrawFeesSchema.safeParse(req.body);

  if (!parsed.success) {
    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: { error: 'validation_failed', reason: parsed.error.errors[0]?.message },
      timestamp: new Date().toISOString(),
    });
    res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body', code: ErrorCode.VALIDATION_ERROR });
    return;
  }

  const { recipient } = parsed.data;

  // Concurrency guard: reject duplicate simultaneous withdrawals.
  if (withdrawalInProgress) {
    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: { recipient, error: 'concurrent_withdrawal_rejected' },
      timestamp: new Date().toISOString(),
      contractAction: 'withdraw_fees',
    });
    res.status(409).json({ success: false, error: 'A withdrawal is already in progress', code: ErrorCode.CONFLICT });
    return;
  }

  withdrawalInProgress = true;
  try {
    const result: FeeWithdrawalResult = await stellarWithdrawFees(recipient);

    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: {
        recipient,
        transactionId: result.transactionId,
        amount: result.amount,
        token: result.token,
        outcome: 'success',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'withdraw_fees',
    });

    res.status(200).json({
      success: true,
      data: {
        transactionId: result.transactionId,
        recipient: result.recipient,
        amount: result.amount,
        token: result.token,
      },
    });
  } catch (err) {
    const errorCode = err instanceof FeeWithdrawalError ? err.code : 'UNKNOWN';
    const retryable = err instanceof FeeWithdrawalError ? err.retryable : false;

    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: {
        recipient,
        error: err instanceof Error ? err.message : 'unknown_error',
        errorCode,
        retryable,
        outcome: 'failure',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'withdraw_fees',
    });

    if (err instanceof FeeWithdrawalError) {
      switch (err.code) {
        case 'NO_FEES':
          res.status(409).json({ success: false, error: 'No fees available to withdraw', code: ErrorCode.NO_FEES });
          return;
        case 'CONTRACT_PAUSED':
          res.status(409).json({ success: false, error: 'Contract is paused; withdrawal not available', code: ErrorCode.CONTRACT_PAUSED });
          return;
        case 'INVALID_RECIPIENT':
          res.status(400).json({ success: false, error: 'Invalid recipient address', code: ErrorCode.INVALID_RECIPIENT });
          return;
        case 'NETWORK_ERROR':
          res.status(503).json({ success: false, error: 'Network error; please retry', code: ErrorCode.NETWORK_ERROR });
          return;
      }
    }
    next(err);
  } finally {
    withdrawalInProgress = false;
  }
}

const reindexSchema = z.object({
  fromLedger: z.number().int().min(0),
});

/**
 * GET /api/admin/validators/:wallet/stats
 * Returns validator stats: milestones_approved and milestones_rejected.
 */
export async function getValidatorStatsEndpoint(req: Request, res: Response, next: NextFunction) {
  try {
    const wallet = req.params.wallet;
    // Validate wallet address
    if (!STELLAR_ADDRESS_RE.test(wallet)) {
      res.status(400).json({ success: false, error: 'Invalid validator wallet address' });
      return;
    }
    const stats = getValidatorStats(wallet);
    if (stats) {
      res.json({
        success: true,
        data: {
          wallet: stats.wallet,
          milestones_approved: stats.milestones_approved,
          milestones_rejected: stats.milestones_rejected
        }
      });
    } else {
      res.json({
        success: true,
        data: {
          wallet,
          milestones_approved: 0,
          milestones_rejected: 0
        }
      });
    }
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/indexer/reindex
 * Resets the indexer's last_ledger to fromLedger so the next poll replays from that point.
 */
export async function reindex(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reindexSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'fromLedger must be a non-negative integer', code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const { fromLedger } = parsed.data;
    const previous = getLastLedger();
    setLastLedger(fromLedger);
    res.json({ success: true, data: { fromLedger, previous } });
  } catch (err) {
    next(err);
  }
}

const updatePlatformFeeSchema = z.object({
  platformFeeBps: z.number().int().min(0).max(10000), // 0-100% in basis points
});

/**
 * POST /api/admin/platform-fee
 * Update platform fee configuration on-chain
 */
export async function updatePlatformFee(req: Request, res: Response, next: NextFunction) {
  try {
    if (req.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }

    const adminWallet = req.account ?? 'unknown';
    const parsed = updatePlatformFeeSchema.safeParse(req.body);

    if (!parsed.success) {
      logAuditEvent({
        action: 'platform_fee_update_attempt',
        adminWallet,
        queryParams: { error: 'validation_failed', reason: parsed.error.errors[0]?.message },
        timestamp: new Date().toISOString(),
      });
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
      return;
    }

    const { platformFeeBps } = parsed.data;

    logger.info(`[admin] action=update_platform_fee admin=${adminWallet} platformFeeBps=${platformFeeBps}`);
    logAuditEvent({
      action: 'platform_fee_update_attempt',
      adminWallet,
      queryParams: { platformFeeBps, outcome: 'submitted' },
      timestamp: new Date().toISOString(),
      contractAction: 'set_platform_fee_bps',
    });

    // NOTE: Contract-level update is simulated. Real invocation will call set_platform_fee_bps() on the Soroban contract.
    res.status(202).json({
      success: true,
      message: `Platform fee update to ${platformFeeBps} bps submitted (simulated)`,
      transactionId: 'stub-platform-fee-txn-placeholder',
    });
  } catch (err) {
    next(err);
  }
}

// ─── Webhook delivery history ─────────────────────────────────────────────────

const webhookDeliveryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  windowMs: z.coerce.number().int().min(1).optional(),
});

/**
 * GET /api/admin/webhooks/:id/deliveries
 *
 * Returns paginated delivery-attempt records for a given webhook subscription.
 * `:id` is the subscription identifier (URL-encoded endpoint URL).
 *
 * @query limit   - Page size (1–100, default 20)
 * @query offset  - Row offset (default 0)
 * @response 200 { success: true, data: WebhookDeliveryRow[], total, limit, offset }
 */
export async function getWebhookDeliveriesEndpoint(req: Request, res: Response, next: NextFunction) {
  try {
    const subscriptionId = decodeURIComponent(req.params.id);
    const parsed = webhookDeliveryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }
    const { limit, offset } = parsed.data;
    const { data, total } = getWebhookDeliveries({ subscriptionId, limit, offset });
    res.json({ success: true, data, total, limit, offset });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/webhooks/:id/summary
 *
 * Returns a rolled-up success-rate summary for a subscription over a time window.
 *
 * @query windowMs  - Window size in milliseconds (default: 86400000 = 24 h)
 * @response 200 { success: true, data: WebhookDeliverySummary }
 */
export async function getWebhookDeliverySummaryEndpoint(req: Request, res: Response, next: NextFunction) {
  try {
    const subscriptionId = decodeURIComponent(req.params.id);
    const parsed = webhookDeliveryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }
    const windowMs = parsed.data.windowMs ?? 24 * 60 * 60 * 1000;
    const summary = getWebhookDeliverySummary(subscriptionId, windowMs);
    res.json({ success: true, data: summary });
  } catch (err) {
    next(err);
  }
}
