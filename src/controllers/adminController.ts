import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { queryEvents, getEventsCount, fetchLastIndexedLedger, persistLastIndexedLedger, getValidatorStats, getAuditLogs, getAuditLogsCount, AuditLogRow } from '../db';
import { getAllValidators, insertValidator, revokeValidatorRow, getValidatorByWallet } from '../services/indexer';
import { isValidStellarAddress } from '../utils/stellarAddress';
import { logAuditEvent } from '../services/audit';
import { verifyAuditChain } from '../utils/auditVerify';
import { withdrawFees as stellarWithdrawFees, FeeWithdrawalError, FeeWithdrawalResult, pauseContractOnChain, unpauseContractOnChain, registerValidatorOnChain, ValidatorActionError } from '../services/stellar';
import { revokeToken, isTokenRevoked } from '../services/tokenBlocklist';
import config from '../config';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import { proposeAction, approveAction, listPendingActions, getActionDetails } from '../services/adminMultiSig';
import type { ApiResponse, EventRecord, ContractEventType } from '../types';

// ─── Audit trail types & constants (#832) ─────────────────────────────────────

/**
 * The exhaustive set of audit event types that the platform can emit.
 * Used for validation of the ?eventType query parameter.
 */
export const KNOWN_AUDIT_EVENT_TYPES = [
  // Admin action events (event_source = 'admin_action')
  'fee_history_query',
  'contract_state_change',
  'validator_registration',
  'validator_revocation',
  'fee_withdrawal_attempt',
  'platform_fee_update_attempt',
  'bulk_validator_import',
  // App-level events (event_source = 'app_event')
  'player_registered',
  'profile_updated',
  'milestone_submitted',
  'milestone_approved',
  'player_search',
  'pending_milestones_viewed',
  // Auth events
  'auth_failed',
  'auth_forbidden',
] as const;

export type AuditEventType = (typeof KNOWN_AUDIT_EVENT_TYPES)[number];

/**
 * Canonical response shape for a single audit log entry (#832).
 * Maps the internal `audit_log` column names to the public API contract.
 */
export interface AuditEntryResponse {
  id: number;
  event_type: string;
  actor_wallet: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  hash: string;
}

/**
 * Convert a raw DB row to the public AuditEntry response shape.
 * `target_id` is extracted from query_params if present there.
 */
function rowToAuditEntry(row: AuditLogRow): AuditEntryResponse {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(row.query_params) as Record<string, unknown>;
  } catch {
    // Leave params empty — malformed JSON should not crash the endpoint.
  }
  const { target_id, targetId, validatorWallet, player_id, playerId, ...rest } = params;
  // Prefer explicit target_id / targetId keys; fall back to common domain keys.
  const resolvedTargetId =
    (target_id as string | undefined) ??
    (targetId as string | undefined) ??
    (validatorWallet as string | undefined) ??
    (player_id as string | undefined) ??
    (playerId as string | undefined) ??
    null;
  return {
    id: row.id,
    event_type: row.action,
    actor_wallet: row.admin_wallet,
    target_id: resolvedTargetId,
    metadata: { ...rest },
    created_at: row.created_at,
    hash: row.hash,
  };
}

// Use shared validator for Stellar public keys

/** GET /api/admin/stats */
export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: {
        players: queryEvents('player_registered').length,
        milestones: queryEvents('milestone_approved').length,
        subscriptions: queryEvents('scout_subscribed').length,
        events: queryEvents().length,
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

/** GET /api/admin/audit (legacy #345 endpoint — backward-compatible) */
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

// ─── Audit trail endpoint (#832) ──────────────────────────────────────────────

const auditTrailQuerySchema = z.object({
  /** Filter by audit event type. Must be one of the known event types. */
  eventType: z
    .string()
    .refine(
      (v) => (KNOWN_AUDIT_EVENT_TYPES as readonly string[]).includes(v),
      (v) => ({ message: `Invalid eventType "${v}". Must be one of: ${KNOWN_AUDIT_EVENT_TYPES.join(', ')}` })
    )
    .optional(),
  /** ISO 8601 start of date range (inclusive). */
  from: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), { message: 'from must be a valid ISO 8601 date string' })
    .optional(),
  /** ISO 8601 end of date range (inclusive). */
  to: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), { message: 'to must be a valid ISO 8601 date string' })
    .optional(),
  /** 1-based page number (default: 1). */
  page: z.coerce.number().int().min(1).default(1),
  /** Number of entries per page, max 100 (default: 50). */
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).refine(
  (d) => {
    if (d.from && d.to) {
      return new Date(d.from) <= new Date(d.to);
    }
    return true;
  },
  { message: 'from must not be after to' }
);

/**
 * GET /api/admin/audit/trail
 *
 * Returns paginated, filterable audit trail entries in a structured AuditEntry
 * shape. Accepts ?eventType=, ?from=, ?to= (ISO 8601), ?page=, ?pageSize=.
 *
 * @response 200 { success: true, data: AuditEntry[], total, page, pageSize }
 * @response 400 { success: false, error: string } - Invalid query parameters
 * @auth Bearer (admin role required)
 */
export async function getAuditTrail(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = auditTrailQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const { eventType, from, to, page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;

    const rows = getAuditLogs({
      action: eventType,
      startDate: from,
      endDate: to,
      limit: pageSize,
      offset,
    });

    const total = getAuditLogsCount({
      action: eventType,
      startDate: from,
      endDate: to,
    });

    res.json({
      success: true,
      data: rows.map(rowToAuditEntry),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/audit/verify
 *
 * Walks the audit_log hash chain end-to-end and reports whether it is intact,
 * or — if not — the id of the first row where it breaks (see #464). Useful
 * for periodic compliance checks / incident response: a `valid: false`
 * result means a historical row was edited, deleted, or reordered outside
 * the application (e.g. direct DB access).
 */
export async function getAuditChainVerification(req: Request, res: Response, next: NextFunction) {
  try {
    const result = verifyAuditChain();
    res.json({ success: true, data: result });
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
    let events = queryEvents(eventTypeFilter, { limit, offset }) as unknown as EventRecord[];
    if (startDate) events = events.filter((e) => new Date(e.created_at ?? 0) >= startDate!);
    if (endDate) events = events.filter((e) => new Date(e.created_at ?? 0) <= endDate!);

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
    const withdrawals = queryEvents('fees_withdrawn').map((e) => e.payload as Record<string, unknown>);
    const body: ApiResponse<Record<string, unknown>[]> = { success: true, data: withdrawals };
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/validators */
export async function listValidators(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: getAllValidators() });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/validators/register
 * Invokes register_validator(validator) on the Soroban contract via the
 * platform keypair. The local `validators` row is only inserted after
 * on-chain confirmation, so a failed/rejected chain call never leaves a
 * local row that doesn't reflect contract state.
 */
export async function registerValidator(req: Request, res: Response, next: NextFunction) {
  const adminWallet = req.account ?? 'unknown';
  const { validatorWallet } = req.body as { validatorWallet?: string };

  if (!validatorWallet || !isValidStellarAddress(validatorWallet)) {
    logger.warn(`[admin] register_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`);
    res.status(400).json({ success: false, error: 'validatorWallet must be a valid Stellar address', code: ErrorCode.VALIDATION_ERROR });
    return;
  }

  try {
    logger.info(`[admin] action=register_validator admin=${adminWallet} target=${validatorWallet}`);
    // Audit the attempt before submitting the on-chain transaction (pre-transaction state).
    logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: { validatorWallet },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    });

    const result = await registerValidatorOnChain(validatorWallet);

    // Only mutate the local row once the chain has confirmed the register —
    // never mark it active locally while the contract call is still in flight.
    insertValidator(validatorWallet, result.transactionId);

    logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: { validatorWallet, transactionId: result.transactionId, outcome: 'success' },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    });

    res.status(202).json({
      success: true,
      message: `Validator ${validatorWallet} registration submitted`,
      transactionId: result.transactionId,
    });
  } catch (err) {
    logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: {
        validatorWallet,
        error: err instanceof Error ? err.message : 'unknown_error',
        errorCode: err instanceof ValidatorActionError ? err.code : 'UNKNOWN',
        outcome: 'failure',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    });

    if (err instanceof ValidatorActionError) {
      switch (err.code) {
        case 'ALREADY_REGISTERED':
          res.status(409).json({ success: false, error: 'Validator is already registered on-chain', code: ErrorCode.CONFLICT });
          return;
        case 'UNAUTHORIZED':
          res.status(403).json({ success: false, error: 'Unauthorized to register this validator', code: ErrorCode.FORBIDDEN });
          return;
        case 'NETWORK_ERROR':
          res.status(503).json({ success: false, error: 'Network error; please retry', code: ErrorCode.NETWORK_ERROR });
          return;
      }
    }
    next(err);
  }
}

/**
 * POST /api/admin/validators/revoke
 * Invokes revoke_validator(validator) on the Soroban contract via the
 * platform keypair. The local `validators` row is only marked revoked after
 * on-chain confirmation, so a failed/rejected chain call never leaves the
 * local row out of sync with contract state.
 */
export async function revokeValidator(req: Request, res: Response, next: NextFunction) {
  const adminWallet = req.account ?? 'unknown';
  const { validatorWallet } = req.body as { validatorWallet?: string };

  if (!validatorWallet || !isValidStellarAddress(validatorWallet)) {
    logger.warn(`[admin] revoke_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`);
    res.status(400).json({ success: false, error: 'validatorWallet must be a valid Stellar address', code: ErrorCode.VALIDATION_ERROR });
    return;
  }

  try {
    // Short-circuit on already-revoked local state before touching the chain.
    const existing = getValidatorByWallet(validatorWallet);
    if (existing?.revoked_at != null) {
      res.status(409).json({
        success: false,
        error: `Validator ${validatorWallet} is already revoked`,
        code: ErrorCode.CONFLICT,
      });
      return;
    }

    logger.info(`[admin] action=revoke_validator admin=${adminWallet} target=${validatorWallet}`);
    // Audit the attempt before submitting the on-chain transaction (pre-transaction state).
    logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: { validatorWallet },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    });

    const result = await revokeValidatorOnChain(validatorWallet);

    // Only mutate the local row once the chain has confirmed the revoke —
    // never mark revoked locally while the contract call is still in flight.
    revokeValidatorRow(validatorWallet, result.transactionId);

    logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: { validatorWallet, transactionId: result.transactionId, outcome: 'success' },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    });

    res.status(202).json({
      success: true,
      message: `Validator ${validatorWallet} revocation submitted`,
      transactionId: result.transactionId,
    });
  } catch (err) {
    logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: {
        validatorWallet,
        error: err instanceof Error ? err.message : 'unknown_error',
        errorCode: err instanceof ValidatorActionError ? err.code : 'UNKNOWN',
        outcome: 'failure',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    });

    if (err instanceof ValidatorActionError) {
      switch (err.code) {
        case 'ALREADY_REVOKED':
          res.status(409).json({ success: false, error: 'Validator is already revoked on-chain', code: ErrorCode.CONFLICT });
          return;
        case 'NOT_REGISTERED':
          res.status(409).json({ success: false, error: 'Wallet is not a registered validator on-chain', code: ErrorCode.CONFLICT });
          return;
        case 'UNAUTHORIZED':
          res.status(403).json({ success: false, error: 'Unauthorized to revoke this validator', code: ErrorCode.FORBIDDEN });
          return;
        case 'NETWORK_ERROR':
          res.status(503).json({ success: false, error: 'Network error; please retry', code: ErrorCode.NETWORK_ERROR });
          return;
      }
    }
    next(err);
  }
}

/**
 * POST /api/admin/contract/pause
 * Invokes pause() on the Soroban contract via the platform keypair.
 * Returns 409 if the contract is already paused.
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
    const proposal = proposeAction('pause_contract', {}, adminWallet);
    if (proposal.status === 'immediate') {
      logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: {},
        timestamp: new Date().toISOString(),
        contractAction: 'pause_contract',
      });

      const result = await pauseContractOnChain();

      logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: { transactionId: result.transactionId, outcome: 'success' },
        timestamp: new Date().toISOString(),
        contractAction: 'pause_contract',
      });

      res.status(202).json({
        success: true,
        message: 'Contract paused successfully',
        transactionId: result.transactionId,
      });
      return;
    }
    res.status(202).json({
      success: true,
      message: `Contract pause proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold },
    });
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'CONTRACT_ALREADY_PAUSED') {
      res.status(409).json({ success: false, error: 'Contract is already paused', code: ErrorCode.CONFLICT });
      return;
    }
    next(err);
  }
}

/**
 * POST /api/admin/contract/unpause
 * Invokes unpause() on the Soroban contract via the platform keypair.
 * Returns 409 if the contract is not currently paused.
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
    const proposal = proposeAction('unpause_contract', {}, adminWallet);
    if (proposal.status === 'immediate') {
      logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: {},
        timestamp: new Date().toISOString(),
        contractAction: 'unpause_contract',
      });

      const result = await unpauseContractOnChain();

      logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: { transactionId: result.transactionId, outcome: 'success' },
        timestamp: new Date().toISOString(),
        contractAction: 'unpause_contract',
      });

      res.status(202).json({
        success: true,
        message: 'Contract unpaused successfully',
        transactionId: result.transactionId,
      });
      return;
    }
    res.status(202).json({
      success: true,
      message: `Contract unpause proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold },
    });
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'CONTRACT_NOT_PAUSED') {
      res.status(409).json({ success: false, error: 'Contract is not currently paused', code: ErrorCode.CONFLICT });
      return;
    }
    next(err);
  }
}

const revokeTokenSchema = z.object({
  jti: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
}).refine((d) => !!d.jti || !!d.token, { message: 'jti or token is required' });

/** POST /api/admin/tokens/revoke */
export async function revokeTokenController(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = revokeTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'jti or token is required', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    const defaultExpiresAt = Math.floor(Date.now() / 1000) + 86400;
    let jti = parsed.data.jti;
    let expiresAt = defaultExpiresAt;

    if (!jti && parsed.data.token) {
      const decoded = jwt.decode(parsed.data.token) as jwt.JwtPayload | null;
      if (!decoded?.jti) {
        res.status(400).json({ success: false, error: 'Token does not contain a jti claim', code: ErrorCode.VALIDATION_ERROR });
        return;
      }
      jti = decoded.jti;
      expiresAt = decoded.exp ?? defaultExpiresAt;
    }

    revokeToken(jti as string, expiresAt);
    res.json({ success: true, data: { jti } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/introspect
 *
 * Decodes the caller's OWN bearer token (from the Authorization header) only.
 * Any `token` field in the request body is intentionally ignored — accepting
 * an arbitrary token there would let an admin introspect another user's
 * claims (#279).
 */
export async function introspectToken(req: Request, res: Response, next: NextFunction) {
  try {
    // requireRole('admin') has already verified this header's token.
    // Any `token` field in the request body is intentionally ignored — accepting
    // an arbitrary token there would let an admin introspect another user's
    // claims (#279).
    const callerToken = (req.headers.authorization ?? '').slice(7);
    const payload = jwt.decode(callerToken) as jwt.JwtPayload | null;
    if (!payload) {
      res.status(400).json({ success: false, error: 'Invalid or expired token', code: ErrorCode.TOKEN_INVALID });
      return;
    }

    // Revocation check — only meaningful when the token carries a jti claim.
    const revoked = payload.jti ? isTokenRevoked(payload.jti) : false;

    // A token is valid when it has not expired AND has not been revoked.
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = payload.exp !== undefined ? payload.exp <= nowSec : false;
    const valid = !expired && !revoked;

    // Human-readable ISO 8601 timestamps (supplementary — tests do not require these).
    const iatIso = payload.iat !== undefined ? new Date(payload.iat * 1000).toISOString() : undefined;
    const expIso = payload.exp !== undefined ? new Date(payload.exp * 1000).toISOString() : undefined;

    res.json({
      success: true,
      data: {
        // Fields required by existing tests — kept at the top level of data.
        sub: payload.sub,
        role: payload.role,
        iat: payload.iat,
        exp: payload.exp,
        // Supplementary fields added by this issue.
        valid,
        ...(revoked && { revoked: true }),
        ...(iatIso !== undefined && { iatIso }),
        ...(expIso !== undefined && { expIso }),
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
    const proposal = proposeAction('withdraw_fees', { recipient: parsed.data.recipient }, adminWallet);
    res.status(202).json({
      success: true,
      message: `Fee withdrawal proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold, recipient: parsed.data.recipient },
    });
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
    if (!isValidStellarAddress(wallet)) {
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
    const previous = fetchLastIndexedLedger();
    persistLastIndexedLedger(fromLedger);
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

/**
 * GET /api/admin/actions/pending
 * List all pending multi-admin actions (expired ones are purged on read).
 */
export async function getPendingActions(req: Request, res: Response, next: NextFunction) {
  try {
    const actions = listPendingActions().map((a) => ({
      id: a.id,
      actionType: a.action_type,
      proposer: a.proposer,
      payload: JSON.parse(a.payload),
      collectedSignatures: a.collected_signatures,
      requiredSignatures: a.required_signatures,
      expiresAt: a.expires_at,
      createdAt: a.created_at,
    }));
    res.json({ success: true, data: actions });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/actions/:id
 * Get details of a specific pending action including collected signers.
 */
export async function getPendingActionById(req: Request, res: Response, next: NextFunction) {
  try {
    const details = getActionDetails(req.params.id);
    if (!details) {
      res.status(404).json({ success: false, error: 'Action not found', code: ErrorCode.NOT_FOUND });
      return;
    }
    res.json({
      success: true,
      data: {
        id: details.action.id,
        actionType: details.action.action_type,
        proposer: details.action.proposer,
        payload: JSON.parse(details.action.payload),
        status: details.action.status,
        collectedSignatures: details.action.collected_signatures,
        requiredSignatures: details.action.required_signatures,
        expiresAt: details.action.expires_at,
        createdAt: details.action.created_at,
        signers: details.signatures.map((s) => ({ wallet: s.signer, signedAt: s.signed_at })),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/actions/:id/approve
 * Co-sign a pending multi-admin action.
 */
export async function approvePendingAction(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';

    if (!config.adminWallets.includes(adminWallet)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }

    const result = approveAction(req.params.id, adminWallet);

    if (result.status === 'duplicate') {
      res.status(409).json({
        success: false,
        error: 'Admin has already signed this action',
        code: ErrorCode.CONFLICT,
        data: { actionId: result.actionId, collectedSignatures: result.collected, requiredSignatures: result.required },
      });
      return;
    }

    if (result.status === 'approved') {
      res.status(200).json({
        success: true,
        message: 'Approval threshold reached — action executed',
        data: {
          actionId: result.actionId,
          collectedSignatures: result.collected,
          requiredSignatures: result.required,
          status: 'executed',
        },
      });
      return;
    }

    res.status(202).json({
      success: true,
      message: `Signature recorded, ${result.required - result.collected} more signature(s) needed`,
      data: {
        actionId: result.actionId,
        collectedSignatures: result.collected,
        requiredSignatures: result.required,
        status: 'pending',
      },
    });
  } catch (err) {
    const error = err as Error & { code?: string; status?: number };
    if (error.status === 404) {
      res.status(404).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 410) {
      res.status(410).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 409) {
      res.status(409).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 403) {
      res.status(403).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 400) {
      res.status(400).json({ success: false, error: error.message, code: error.code });
      return;
    }
    next(err);
  }
}

// ─── Validator import types ───────────────────────────────────────────────────

export interface ImportValidatorEntry {
  wallet: string;
  label?: string;
  region?: string;
}

export type ImportResultStatus = 'registered' | 'duplicate' | 'invalid';

export interface ImportValidatorResult {
  wallet: string;
  status: ImportResultStatus;
  reason?: string;
  label?: string;
  region?: string;
}

/**
 * Parse a CSV text body into an array of ImportValidatorEntry objects.
 *
 * Supported formats:
 *   - Single-column:  wallet
 *   - Two-column:     wallet,label
 *   - Three-column:   wallet,label,region
 *
 * Lines beginning with # or empty lines are ignored.
 * A header row whose first token is the literal "wallet" (case-insensitive)
 * is silently skipped.
 */
export function parseCsvBody(text: string): ImportValidatorEntry[] {
  const entries: ImportValidatorEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map((c) => c.trim());
    // Skip header row
    if (cols[0].toLowerCase() === 'wallet') continue;
    const [wallet, label, region] = cols;
    entries.push({ wallet: wallet ?? '', label: label || undefined, region: region || undefined });
  }
  return entries;
}

/**
 * Process a batch of ImportValidatorEntry items and return per-entry results.
 * Delegates registration to the same insertValidator() path used by the single-
 * registration endpoint so no registration logic is duplicated.
 *
 * Duplicate detection:
 *   - A validator that already exists AND is not revoked → "duplicate"
 *   - A validator that was previously revoked is re-registered (same as single-
 *     registration, which also does INSERT OR REPLACE)
 */
export function processBatch(
  entries: ImportValidatorEntry[],
  adminWallet: string,
): ImportValidatorResult[] {
  const results: ImportValidatorResult[] = [];
  // Track wallets already seen in this batch to handle intra-batch duplicates
  const seenInBatch = new Set<string>();

  for (const entry of entries) {
    const { wallet, label, region } = entry;

    // 1. Validate the address
    if (!isValidStellarAddress(wallet)) {
      logger.warn(`[admin] import_validator rejected — invalid address | admin=${adminWallet} target=${wallet}`);
      results.push({ wallet, status: 'invalid', reason: 'invalid Stellar address', label, region });
      continue;
    }

    // 2. Check intra-batch duplicate
    if (seenInBatch.has(wallet)) {
      results.push({ wallet, status: 'duplicate', reason: 'duplicate within batch', label, region });
      continue;
    }

    // 3. Check DB for an already-active (non-revoked) registration
    const existing = getValidatorByWallet(wallet);
    if (existing && existing.revoked_at === null) {
      results.push({ wallet, status: 'duplicate', reason: 'already registered', label, region });
      seenInBatch.add(wallet);
      continue;
    }

    // 4. Register — reuses the same insertValidator path as the single endpoint
    logger.info(`[admin] action=import_register_validator admin=${adminWallet} target=${wallet}`);
    // TODO: invoke register_validator on Soroban contract (same as single-registration endpoint)
    insertValidator(wallet);
    seenInBatch.add(wallet);
    results.push({ wallet, status: 'registered', label, region });
  }

  return results;
}

/**
 * POST /api/admin/validators/import
 *
 * Accepts either:
 *   - JSON body:  { validators: [{ wallet, label?, region? }, …] }
 *   - CSV body:   Content-Type: text/csv  with rows: wallet[,label[,region]]
 *
 * Returns a per-entry result summary so partial failures don't block the whole
 * batch. Invalid addresses and already-registered (non-revoked) validators are
 * skipped cleanly rather than erroring the request.
 *
 * @response 200 { success: true, data: { results, summary: { total, registered, duplicates, invalid } } }
 * @response 400 { success: false, error: string } - Unparseable body or no entries
 * @auth Bearer (admin role required)
 */
export async function importValidators(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    const contentType = (req.headers['content-type'] ?? '').toLowerCase();

    let entries: ImportValidatorEntry[];

    if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      // ── CSV path ──────────────────────────────────────────────────────────
      const rawBody = req.body as string;
      if (typeof rawBody !== 'string' || !rawBody.trim()) {
        res.status(400).json({ success: false, error: 'CSV body is empty', code: ErrorCode.VALIDATION_ERROR });
        return;
      }
      entries = parseCsvBody(rawBody);
    } else {
      // ── JSON path (default) ───────────────────────────────────────────────
      const jsonBody = req.body as { validators?: unknown };
      if (!jsonBody || !Array.isArray(jsonBody.validators)) {
        res.status(400).json({
          success: false,
          error: 'Request body must contain a "validators" array or use Content-Type: text/csv',
          code: ErrorCode.VALIDATION_ERROR,
        });
        return;
      }

      // Coerce each item — we accept { wallet } at minimum; label/region are optional strings
      entries = (jsonBody.validators as Array<unknown>).map((item) => {
        if (typeof item === 'string') return { wallet: item };
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          return {
            wallet: typeof obj['wallet'] === 'string' ? obj['wallet'] : '',
            label: typeof obj['label'] === 'string' ? obj['label'] : undefined,
            region: typeof obj['region'] === 'string' ? obj['region'] : undefined,
          };
        }
        return { wallet: '' };
      });
    }

    if (entries.length === 0) {
      res.status(400).json({ success: false, error: 'No validator entries found in request', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    const results = processBatch(entries, adminWallet);

    const registered = results.filter((r) => r.status === 'registered').length;
    const duplicates = results.filter((r) => r.status === 'duplicate').length;
    const invalid = results.filter((r) => r.status === 'invalid').length;

    logger.info(
      `[admin] action=import_validators admin=${adminWallet} total=${results.length} registered=${registered} duplicates=${duplicates} invalid=${invalid}`,
    );

    logAuditEvent({
      action: 'bulk_validator_import',
      adminWallet,
      queryParams: { total: results.length, registered, duplicates, invalid },
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      data: {
        results,
        summary: {
          total: results.length,
          registered,
          duplicates,
          invalid,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}
