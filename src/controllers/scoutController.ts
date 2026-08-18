import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  queryEvents,
  getPlayerById,
  getLatestSubscription,
  insertSubscription,
  dbRenewSubscription,
  dbCancelSubscription,
  insertContactUnlock,
  getContactUnlocksByScout,
  hasContactUnlock,
  getIdempotencyRecord,
  saveIdempotencyRecord,
} from '../db';
import {
  submitContactPayment,
  isSubscribed,
  purchaseSubscription,
  PaymentError,
  SubscriptionError,
  renewSubscription as stellarRenewSubscription,
  logTrialOffer as stellarLogTrialOffer,
  cancelSubscriptionOnChain,
} from '../services/stellar';
import { isValidStellarAddress } from '../utils/stellarAddress';
import { logger } from '../utils/logger';
import config from '../config';
import { ErrorCode } from '../utils/errorCodes';
import { insertTrialOffer, getTrialOffers } from '../services/indexer';
import { invokeContract, strVal } from '../utils/contract';
import { isValidEvidenceUri } from '../utils/uriValidator';

// ─── Validation schemas ────────────────────────────────────────────────────────

export const trialOfferSchema = z.object({
  playerId: z.string().min(1),
  detailsUri: z
    .string()
    .min(1)
    .refine(isValidEvidenceUri, 'detailsUri must be a valid IPFS (ipfs://) or HTTPS URI'),
});

/**
 * Body schema for POST /scouts/:wallet/contacts/:playerId/unlock.
 * Currently the unlock operation only uses URL params (wallet, playerId),
 * so the body is intentionally empty. Defining it explicitly ensures
 * unexpected fields are stripped and the route is ready for future body fields.
 */
export const unlockContactSchema = z.object({}).strict();

const subscribeSchema = z.object({
  tier: z.enum(['basic', 'premium']),
  duration: z.number().int().min(1).max(365),
});

// ─── Access helpers ────────────────────────────────────────────────────────────

/**
 * Returns the grace-period-aware expiry threshold.
 * A subscription is considered "live" until expiresAt + gracePeriodSeconds.
 */
function gracePeriodSeconds(): number {
  return config.subscriptionGracePeriodHours * 3600;
}

/**
 * Returns true if the scout currently has paid access to the player —
 * either an active (or grace-period) subscription or a previously unlocked contact.
 */
async function scoutHasPlayerAccess(scoutWallet: string, playerId: string): Promise<boolean> {
  // 1. On-chain subscription check (stub currently returns inactive)
  const onChain = await isSubscribed(scoutWallet);
  if (onChain.active) return true;

  const now = Math.floor(Date.now() / 1000);
  const graceThreshold = now - gracePeriodSeconds();

  // 2. Local subscriptions table (authoritative for renewal/cancellation state)
  const localSub = await getLatestSubscription(scoutWallet);
  if (localSub && localSub.expires_at > graceThreshold) return true;

  // 3. Indexed scout_subscribed events (fallback for pre-table records)
  const subs = queryEvents('scout_subscribed').filter((e) => e.payload.scout === scoutWallet);
  const latestSub = subs.at(-1);
  if (latestSub) {
    const expiresAt = latestSub.payload.subscription_expiry as number;
    if (expiresAt > graceThreshold) return true;
  }

  // 4. Dedicated contact_unlocks table
  return await hasContactUnlock(scoutWallet, playerId);
}

// ─── GET /api/scouts/:wallet/subscription ─────────────────────────────────────

/** GET /api/scouts/:wallet/subscription */
export async function getSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
    if (!isValidStellarAddress(wallet)) {
      res.status(400).json({ success: false, error: 'Invalid Stellar address' });
      return;
    }
    if (req.account !== wallet) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: ErrorCode.UNAUTHORIZED });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const graceSeconds = gracePeriodSeconds();

    // On-chain verification stub — falls back to local DB / indexed events when stub returns inactive
    const onChain = await isSubscribed(wallet);
    if (onChain.active) {
      res.json({
        success: true,
        data: {
          active: true,
          tier: 'basic',
          expiresAt: onChain.expiresAt,
          remainingDays: null,
          gracePeriodActive: false,
        },
      });
      return;
    }

    // Check local subscriptions table first
    const localSub = await getLatestSubscription(wallet);
    if (localSub) {
      const active = localSub.expires_at > now;
      const gracePeriodActive = !active && localSub.expires_at > now - graceSeconds;
      const remainingDays = active ? Math.ceil((localSub.expires_at - now) / 86400) : 0;
      res.json({
        success: true,
        data: {
          active: active || gracePeriodActive,
          tier: localSub.tier,
          expiresAt: localSub.expires_at,
          remainingDays,
          gracePeriodActive,
        },
      });
      return;
    }

    // Fall back to indexed events
    const subs = queryEvents('scout_subscribed').filter((e) => e.payload.scout === wallet);
    const latest = subs.at(-1);
    if (!latest) {
      res.json({
        success: true,
        data: { active: false, tier: null, expiresAt: null, remainingDays: 0, gracePeriodActive: false },
      });
      return;
    }
    const expiresAt = latest.payload.subscription_expiry as number;
    const active = expiresAt > now;
    const gracePeriodActive = !active && expiresAt > now - graceSeconds;
    const remainingDays = active ? Math.ceil((expiresAt - now) / 86400) : 0;
    res.json({
      success: true,
      data: {
        active: active || gracePeriodActive,
        tier: (latest.payload.tier as string) ?? 'basic',
        expiresAt,
        remainingDays,
        gracePeriodActive,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/scouts/:wallet/subscribe ───────────────────────────────────────

/** POST /api/scouts/:wallet/subscribe — new subscription */
export async function subscribe(req: Request, res: Response, next: NextFunction) {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  try {
    const { wallet } = req.params;
    if (req.account !== wallet) {
      res.status(403).json({ success: false, error: 'Forbidden: wallet does not match authenticated account' });
      return;
    }

    // Safe retries (#idempotency): a duplicate key within the TTL returns the
    // cached response instead of triggering a new on-chain transaction.
    if (idempotencyKey) {
      const cached = await getIdempotencyRecord(idempotencyKey);
      if (cached) {
        res.status(cached.status_code).json(JSON.parse(cached.response));
        return;
      }
    }

    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
      return;
    }
    const { tier, duration } = parsed.data;
    const result = await purchaseSubscription(wallet, tier, duration);

    // Persist locally
    await insertSubscription({
      scout_wallet: wallet,
      tier,
      expires_at: result.expiresAt,
      created_at: Math.floor(Date.now() / 1000),
    });

    const body = { success: true, data: result };
    if (idempotencyKey) await saveIdempotencyRecord(idempotencyKey, 201, body);
    res.status(201).json(body);
  } catch (err) {
    if (err instanceof PaymentError) {
      const body = { success: false, error: err.message, code: err.code };
      if (idempotencyKey) await saveIdempotencyRecord(idempotencyKey, 402, body);
      res.status(402).json(body);
      return;
    }
    next(err);
  }
}

// ─── PUT /api/scouts/:wallet/subscribe ────────────────────────────────────────

/**
 * PUT /api/scouts/:wallet/subscribe — renew or create subscription.
 * If an active (or grace-period) subscription exists, extends its expiry.
 * If none exists, behaves like POST (creates new).
 * Returns 200 for renewal, 201 for new subscription.
 */
export async function renewSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
    if (req.account !== wallet) {
      res.status(403).json({ success: false, error: 'Forbidden: wallet does not match authenticated account' });
      return;
    }
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
      return;
    }
    const { tier, duration } = parsed.data;

    const existingSub = await getLatestSubscription(wallet);

    if (existingSub) {
      // Renewal path — extend existing subscription
      const result = await stellarRenewSubscription(wallet, tier, duration, existingSub.expires_at);

      await dbRenewSubscription({
        id: existingSub.id,
        tier,
        expires_at: result.expiresAt,
      });

      logger.info(`[scout] action=renew_subscription scout=${wallet} tier=${tier} duration=${duration} newExpiry=${result.expiresAt}`);
      res.status(200).json({ success: true, data: result });
    } else {
      // No subscription exists — create a new one (same as POST)
      const result = await purchaseSubscription(wallet, tier, duration);

      await insertSubscription({
        scout_wallet: wallet,
        tier,
        expires_at: result.expiresAt,
        created_at: Math.floor(Date.now() / 1000),
      });

      logger.info(`[scout] action=new_subscription_via_put scout=${wallet} tier=${tier} duration=${duration} expiry=${result.expiresAt}`);
      res.status(201).json({ success: true, data: result });
    }
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(402).json({ success: false, error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

// ─── DELETE /api/scouts/:wallet/subscribe ─────────────────────────────────────

/**
 * DELETE /api/scouts/:wallet/subscribe — cancel an active subscription.
 * Returns 404 if no active subscription exists locally or on-chain.
 * Returns 403 if the contract rejects the caller as unauthorized.
 * Records cancellation on-chain first; DB row is only updated after confirmation.
 */
export async function cancelSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
    if (req.account !== wallet) {
      res.status(403).json({ success: false, error: 'Forbidden: wallet does not match authenticated account' });
      return;
    }

    const existingSub = await getLatestSubscription(wallet);
    if (!existingSub) {
      res.status(404).json({ success: false, error: 'No active subscription found' });
      return;
    }

    // Submit on-chain first — DB is only updated after this succeeds.
    // SubscriptionError (NOT_SUBSCRIBED / UNAUTHORIZED) maps to 4xx.
    // PaymentError maps to 402. Unexpected errors bubble to the 500 handler.
    const onChainResult = await cancelSubscriptionOnChain(wallet);

    const now = Math.floor(Date.now() / 1000);
    await dbCancelSubscription({ id: existingSub.id, cancelled_at: now });

    logger.info(`[scout] action=cancel_subscription scout=${wallet} subId=${existingSub.id} txId=${onChainResult.transactionId}`);

    res.status(200).json({
      success: true,
      data: {
        transactionId: onChainResult.transactionId,
        cancelledAt: now,
        wallet,
      },
    });
  } catch (err) {
    if (err instanceof SubscriptionError) {
      const status = err.code === 'UNAUTHORIZED' ? 403 : 404;
      res.status(status).json({ success: false, error: err.message, code: err.code });
      return;
    }
    if (err instanceof PaymentError) {
      res.status(402).json({ success: false, error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

// ─── GET /api/scouts/:wallet/contacts ─────────────────────────────────────────

/** GET /api/scouts/:wallet/contacts */
export async function getUnlockedContacts(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
    const { playerId } = req.query as { playerId?: string };

    if (!isValidStellarAddress(wallet)) {
      res.status(400).json({ success: false, error: 'Invalid Stellar address' });
      return;
    }
    if (req.account !== wallet) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: ErrorCode.UNAUTHORIZED });
      return;
    }

    let contacts = await getContactUnlocksByScout(wallet);

    if (playerId) {
      contacts = contacts.filter((c) => c.player_id === playerId);
    }

    res.json({
      success: true,
      data: contacts.map((c) => ({
        playerId: c.player_id,
        contact_status: 'unlocked',
        unlockedAt: c.unlocked_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/scouts/:wallet/contacts/:playerId/unlock ───────────────────────

/** POST /api/scouts/:wallet/contacts/:playerId/unlock */
export async function unlockContact(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet, playerId } = req.params;
    if (!isValidStellarAddress(wallet)) {
      res.status(400).json({ success: false, error: 'Invalid Stellar address' });
      return;
    }
    if (!wallet || !playerId) {
      res.status(400).json({ success: false, error: 'wallet and playerId are required', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    if (req.account !== wallet) {
      logger.warn(`[scout] action=unlock_contact_denied scout=${wallet} playerId=${playerId} reason=wallet_mismatch`);
      res.status(403).json({ success: false, error: 'Forbidden: wallet does not match authenticated account', code: ErrorCode.WALLET_MISMATCH });
      return;
    }

    // Idempotent: a player already unlocked by this scout must not be charged again.
    if (await hasContactUnlock(wallet, playerId)) {
      logger.info(`[scout] action=unlock_contact_already_unlocked scout=${wallet} playerId=${playerId}`);
      res.json({ success: true, data: { alreadyUnlocked: true } });
      return;
    }

    logger.info(`[scout] action=unlock_contact_attempt scout=${wallet} playerId=${playerId}`);

    const result = await submitContactPayment(wallet, playerId);
    await insertContactUnlock({
      scout_wallet: wallet,
      player_id: playerId,
      tx_hash: result.transactionId,
      unlocked_at: Math.floor(Date.now() / 1000),
    });
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(402).json({ success: false, error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

// ─── GET/POST /api/scouts/:wallet/trial-offers (#285) ──────────────────────────

/** GET /api/scouts/:wallet/trial-offers — on-chain trial offer event history */
export async function listTrialOffers(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
    res.json({ success: true, data: await getTrialOffers(wallet) });
  } catch (err) {
    next(err);
  }
}

/** POST /api/scouts/:wallet/trial-offers — submit a trial offer on-chain and index it locally */
export async function createTrialOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
    const { playerId, detailsUri } = req.body as { playerId: string; detailsUri: string };

    const result = await invokeContract('log_trial_offer', [strVal(wallet), strVal(playerId), strVal(detailsUri)]);
    const createdAt = Math.floor(Date.now() / 1000);
    await insertTrialOffer(wallet, playerId, detailsUri, result.hash, createdAt);

    res.status(201).json({ success: true, data: { transactionId: result.hash } });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/scouts/:wallet/trial-offer ─────────────────────────────────────

/** POST /api/scouts/:wallet/trial-offer */
export async function submitTrialOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
    const { playerId, detailsUri } = req.body as { playerId: string; detailsUri: string };

    if (req.account !== wallet) {
      logger.warn(`[scout] action=log_trial_offer_denied scout=${wallet} playerId=${playerId} reason=wallet_mismatch`);
      res.status(403).json({ success: false, error: 'Forbidden: wallet does not match authenticated account', code: ErrorCode.WALLET_MISMATCH });
      return;
    }

    const playerExists = queryEvents('player_registered').some((e) => e.payload.player_id === playerId);
    if (!playerExists) {
      res.status(404).json({ success: false, error: 'Player not found', code: ErrorCode.PLAYER_NOT_FOUND });
      return;
    }

    const hasAccess = await scoutHasPlayerAccess(wallet, playerId);
    if (!hasAccess) {
      res.status(402).json({
        success: false,
        error: 'Scout must be subscribed or have paid the contact fee for this player',
        code: ErrorCode.SUBSCRIPTION_REQUIRED,
      });
      return;
    }

    logger.info(`[scout] action=log_trial_offer_attempt scout=${wallet} playerId=${playerId}`);

    const result = await stellarLogTrialOffer(wallet, playerId, detailsUri);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(402).json({ success: false, error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

// ─── GET /api/scouts/:wallet/payments ─────────────────────────────────────────

/** GET /api/scouts/:wallet/payments — payment history */
export async function getPaymentHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
    if (!isValidStellarAddress(wallet)) {
      res.status(400).json({ success: false, error: 'Invalid Stellar address' });
      return;
    }
    if (req.account !== wallet) {
      res.status(403).json({ success: false, error: 'Forbidden: wallet does not match authenticated account', code: ErrorCode.WALLET_MISMATCH });
      return;
    }
    const { from, to } = req.query as { from?: string; to?: string };

    let payments = queryEvents('contact_unlocked')
      .filter((e) => e.payload.scout === wallet)
      .map((e) => ({
        transactionId: (e.payload.tx_hash as string | undefined) ?? null,
        amount: (e.payload.fee ?? '0') as string,
        token: 'XLM',
        timestamp: (e.payload.timestamp ?? new Date(0).toISOString()) as string,
      }));

    if (from) {
      const fromDate = new Date(from).getTime();
      payments = payments.filter((p) => new Date(p.timestamp).getTime() >= fromDate);
    }
    if (to) {
      const toDate = new Date(to).getTime();
      payments = payments.filter((p) => new Date(p.timestamp).getTime() <= toDate);
    }

    res.json({ success: true, data: payments });
  } catch (err) {
    next(err);
  }
}

/** GET /api/scouts/:wallet/contacts/:playerId */
export async function getContactDetails(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet, playerId } = req.params;
    if (req.account !== wallet) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }

    const player = await getPlayerById(playerId);
    if (!player) {
      res.status(404).json({ success: false, error: 'Player not found' });
      return;
    }

    const hasUnlocked = await hasContactUnlock(wallet, playerId);

    if (!hasUnlocked) {
      res.status(403).json({ success: false, error: 'Contact not unlocked' });
      return;
    }

    res.json({
      success: true,
      data: {
        playerId: player.player_id,
        wallet: player.wallet,
        email: `${player.player_id}@example.com`,
        phone: '+1-555-0199',
      },
    });
  } catch (err) {
    next(err);
  }
}
