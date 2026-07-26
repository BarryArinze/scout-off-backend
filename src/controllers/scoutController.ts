import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getEvents, getPlayerById } from '../db';
import { submitContactPayment, isSubscribed, purchaseSubscription, PaymentError } from '../services/stellar';

import { logger } from '../utils/logger';
import config from '../config';
import { inFlightLock } from '../utils/inflightLock';

// ─── Validation schemas ────────────────────────────────────────────────────────

function isValidEvidenceUri(uri: string): boolean {
  return uri.startsWith('ipfs://') || uri.startsWith('https://');
}

export const trialOfferSchema = z.object({
  playerId: z.string().min(1),
  detailsUri: z
    .string()
    .min(1)
    .refine(isValidEvidenceUri, 'detailsUri must be a valid IPFS (ipfs://) or HTTPS URI'),
});

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
  const localSub = getLatestSubscription(scoutWallet);
  if (localSub && localSub.expires_at > graceThreshold) return true;

  // 3. Indexed scout_subscribed events (fallback for pre-table records)
  const subs = getEvents('scout_subscribed').filter((e) => e.payload.scout === scoutWallet);
  const latestSub = subs.at(-1);
  if (latestSub) {
    const expiresAt = latestSub.payload.subscription_expiry as number;
    if (expiresAt > graceThreshold) return true;
  }

  // 4. Per-player contact_unlocked event
  return getEvents('contact_unlocked').some(
    (e) => e.payload.scout === scoutWallet && e.payload.player_id === playerId,
  );
}

// ─── GET /api/scouts/:wallet/subscription ─────────────────────────────────────

/** GET /api/scouts/:wallet/subscription */
export async function getSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
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
    const localSub = getLatestSubscription(wallet);
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
    const subs = getEvents('scout_subscribed').filter((e) => e.payload.scout === wallet);
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

    // Use in-flight lock to prevent concurrent subscription requests for the same wallet
    const result = await inFlightLock.withLock(`subscribe:${wallet}`, async () => {
      return await purchaseSubscription(wallet, tier, duration);
    });

    // Persist locally
    insertSubscription({
      scout_wallet: wallet,
      tier,
      expires_at: result.expiresAt,
      created_at: Math.floor(Date.now() / 1000),
    });

    res.status(201).json({ success: true, data: result });
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(402).json({ success: false, error: err.message, code: err.code });
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

    const existingSub = getLatestSubscription(wallet);

    if (existingSub) {
      // Renewal path — extend existing subscription
      const result = await stellarRenewSubscription(wallet, tier, duration, existingSub.expires_at);

      dbRenewSubscription({
        id: existingSub.id,
        tier,
        expires_at: result.expiresAt,
      });

      logger.info(`[scout] action=renew_subscription scout=${wallet} tier=${tier} duration=${duration} newExpiry=${result.expiresAt}`);
      res.status(200).json({ success: true, data: result });
    } else {
      // No subscription exists — create a new one (same as POST)
      const result = await purchaseSubscription(wallet, tier, duration);

      insertSubscription({
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
 * Returns 404 if no active subscription exists.
 * Records cancellation on-chain and sets cancelled_at locally.
 */
export async function cancelSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
    if (req.account !== wallet) {
      res.status(403).json({ success: false, error: 'Forbidden: wallet does not match authenticated account' });
      return;
    }

    const existingSub = getLatestSubscription(wallet);
    if (!existingSub) {
      res.status(404).json({ success: false, error: 'No active subscription found' });
      return;
    }

    // Record on-chain cancellation intent
    const onChainResult = await cancelSubscriptionOnChain(wallet);

    const now = Math.floor(Date.now() / 1000);
    dbCancelSubscription({ id: existingSub.id, cancelled_at: now });

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

    if (req.account !== wallet) {
      res.status(401).json({ success: false, error: 'Unauthorized', code: ErrorCode.UNAUTHORIZED });
      return;
    }

    let contacts = getEvents('contact_unlocked').filter((e) => e.payload.scout === wallet);

    if (playerId) {
      contacts = contacts.filter((e) => e.payload.player_id === playerId);
    }

    res.json({
      success: true,
      data: contacts.map((e) => ({
        playerId: e.payload.player_id as string,
        contact_status: 'unlocked',
        unlockedAt: e.payload.unlocked_at as number,
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
    if (!wallet || !playerId) {
      res.status(400).json({ success: false, error: 'wallet and playerId are required', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    if (req.account !== wallet) {
      logger.warn(`[scout] action=unlock_contact_denied scout=${wallet} playerId=${playerId} reason=wallet_mismatch`);
      res.status(403).json({ success: false, error: 'Forbidden: wallet does not match authenticated account', code: ErrorCode.WALLET_MISMATCH });
      return;
    }

    logger.info(`[scout] action=unlock_contact_attempt scout=${wallet} playerId=${playerId}`);

    const result = await submitContactPayment(wallet, playerId);
    res.json({ success: true, data: result });
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(402).json({ success: false, error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

// ─── POST /api/scouts/:wallet/trial-offer ─────────────────────────────────────

/** POST /api/scouts/:wallet/trial-offer */
export async function submitTrialOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { wallet } = req.params;
    const { playerId, detailsUri } = req.body as { playerId: string; detailsUri: string };

    if ((req as any).account !== wallet) {
      logger.warn(`[scout] action=log_trial_offer_denied scout=${wallet} playerId=${playerId} reason=wallet_mismatch`);
      res.status(403).json({ success: false, error: 'Forbidden: wallet does not match authenticated account', code: ErrorCode.WALLET_MISMATCH });
      return;
    }

    const playerExists = getEvents('player_registered').some((e) => e.payload.player_id === playerId);
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
    const { from, to } = req.query as { from?: string; to?: string };

    let payments = getEvents('contact_unlocked')
      .filter((e) => e.payload.scout === wallet)
      .map((e, i) => ({
        transactionId: (e.payload.tx_hash ?? `mock-tx-${i}`) as string,
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

    const player = getPlayerById(playerId);
    if (!player) {
      res.status(404).json({ success: false, error: 'Player not found' });
      return;
    }

    const hasUnlocked = getEvents('contact_unlocked').some(
      (e) => e.payload.scout === wallet && e.payload.player_id === playerId
    );

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

