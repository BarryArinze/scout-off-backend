import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getTrialOfferById, respondToTrialOffer, insertTrialOffer } from '../db';
import { queryEvents } from '../db';
import { logger } from '../utils/logger';

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const rejectOfferSchema = z.object({
  reason: z.string().max(500).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the player's wallet from their playerId.
 * We look up the player_registered event for their wallet address.
 */
function getPlayerWallet(playerId: string): string | null {
  const event = queryEvents('player_registered').find(
    (e) => e.payload.player_id === playerId,
  );
  return event ? (event.payload.wallet as string) : null;
}

// ─── POST /api/players/:playerId/trial-offers/:offerId/accept ─────────────────

/**
 * Accept a trial offer addressed to the authenticated player.
 * - 200: offer accepted
 * - 403: non-owner player attempting to respond
 * - 404: offer not found
 * - 409: offer already responded to
 */
export async function acceptTrialOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { playerId, offerId } = req.params;

    // Verify ownership: the authenticated account must own this playerId
    const playerWallet = getPlayerWallet(playerId);
    if (!playerWallet) {
      res.status(404).json({ success: false, error: 'Player not found' });
      return;
    }
    if (req.account !== playerWallet) {
      logger.warn(
        `[trialOffer] accept_denied offerId=${offerId} playerId=${playerId} reason=not_owner account=${req.account}`,
      );
      res.status(403).json({ success: false, error: 'Forbidden: you do not own this player profile' });
      return;
    }

    // Ensure the offer exists and belongs to this player
    let offer = await getTrialOfferById(offerId);

    if (!offer) {
      // Try to seed from on-chain indexed events (backward compatibility)
      const event = queryEvents('trial_offer_logged').find(
        (e) => e.payload.offer_id === offerId || e.payload.player_id === playerId,
      );
      if (!event) {
        res.status(404).json({ success: false, error: 'Trial offer not found' });
        return;
      }
      // Insert the offer from on-chain data so we can record the response
      await insertTrialOffer({
        offer_id: offerId,
        scout_wallet: event.payload.scout as string,
        player_id: playerId,
        details_uri: (event.payload.details_uri ?? '') as string,
        created_at: Math.floor(Date.now() / 1000),
      });
      offer = await getTrialOfferById(offerId);
    }

    if (!offer) {
      res.status(404).json({ success: false, error: 'Trial offer not found' });
      return;
    }

    if (offer.player_id !== playerId) {
      res.status(403).json({ success: false, error: 'Forbidden: offer does not belong to this player' });
      return;
    }

    if (offer.status !== 'pending') {
      res.status(409).json({
        success: false,
        error: `Offer already ${offer.status}`,
        data: { status: offer.status, respondedAt: offer.responded_at },
      });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    await respondToTrialOffer({ offer_id: offerId, status: 'accepted', responded_at: now });

    logger.info(`[trialOffer] accepted offerId=${offerId} playerId=${playerId}`);

    // NOTE: On-chain record of the response is a future step.
    // When the Soroban contract supports `respond_to_offer(offer_id, accepted: bool)`,
    // invoke it here via stellarService.respondToTrialOffer(offerId, 'accepted').

    res.status(200).json({
      success: true,
      data: {
        offerId,
        playerId,
        status: 'accepted',
        respondedAt: now,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/players/:playerId/trial-offers/:offerId/reject ─────────────────

/**
 * Reject a trial offer addressed to the authenticated player.
 * - 200: offer rejected
 * - 403: non-owner player attempting to respond
 * - 404: offer not found
 * - 409: offer already responded to
 */
export async function rejectTrialOffer(req: Request, res: Response, next: NextFunction) {
  try {
    const { playerId, offerId } = req.params;

    // Verify ownership
    const playerWallet = getPlayerWallet(playerId);
    if (!playerWallet) {
      res.status(404).json({ success: false, error: 'Player not found' });
      return;
    }
    if (req.account !== playerWallet) {
      logger.warn(
        `[trialOffer] reject_denied offerId=${offerId} playerId=${playerId} reason=not_owner account=${req.account}`,
      );
      res.status(403).json({ success: false, error: 'Forbidden: you do not own this player profile' });
      return;
    }

    const bodyParsed = rejectOfferSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ success: false, error: bodyParsed.error.errors[0]?.message ?? 'Invalid request body' });
      return;
    }
    const reason = bodyParsed.data.reason;

    let offer = await getTrialOfferById(offerId);

    if (!offer) {
      // Try to seed from on-chain indexed events (backward compatibility)
      const event = queryEvents('trial_offer_logged').find(
        (e) => e.payload.offer_id === offerId || e.payload.player_id === playerId,
      );
      if (!event) {
        res.status(404).json({ success: false, error: 'Trial offer not found' });
        return;
      }
      await insertTrialOffer({
        offer_id: offerId,
        scout_wallet: event.payload.scout as string,
        player_id: playerId,
        details_uri: (event.payload.details_uri ?? '') as string,
        created_at: Math.floor(Date.now() / 1000),
      });
      offer = await getTrialOfferById(offerId);
    }

    if (!offer) {
      res.status(404).json({ success: false, error: 'Trial offer not found' });
      return;
    }

    if (offer.player_id !== playerId) {
      res.status(403).json({ success: false, error: 'Forbidden: offer does not belong to this player' });
      return;
    }

    if (offer.status !== 'pending') {
      res.status(409).json({
        success: false,
        error: `Offer already ${offer.status}`,
        data: { status: offer.status, respondedAt: offer.responded_at },
      });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    await respondToTrialOffer({ offer_id: offerId, status: 'rejected', reject_reason: reason, responded_at: now });

    logger.info(`[trialOffer] rejected offerId=${offerId} playerId=${playerId} reason=${reason ?? 'none'}`);

    // NOTE: On-chain record of the response is a future step (see acceptTrialOffer above).

    res.status(200).json({
      success: true,
      data: {
        offerId,
        playerId,
        status: 'rejected',
        reason: reason ?? null,
        respondedAt: now,
      },
    });
  } catch (err) {
    next(err);
  }
}
