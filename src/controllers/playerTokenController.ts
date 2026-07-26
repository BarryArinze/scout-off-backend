/**
 * playerTokenController.ts
 *
 * Stub handlers for the fractionalized player-sponsorship (Player Token) feature.
 * All endpoints are gated behind the `player_tokens` feature flag. When the flag
 * is off they return 404 so the routes are invisible to callers.
 *
 * Backing store: in-memory Maps — replaced by the Soroban `player_token` contract
 * or a DB table when the feature graduates out of scaffold stage.
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { isFeatureEnabled, FeatureFlags } from '../services/featureFlags';
import { logger } from '../utils/logger';

// ── In-memory stub registry ───────────────────────────────────────────────────
// Key: playerId → Map<holderWallet, tokenBalance>
const holderRegistry = new Map<string, Map<string, number>>();
// Key: playerId → totalSupply
const tokenSupply = new Map<string, number>();

/** Seed a player's token supply (used by integration tests). */
export function _stubSeedTokens(playerId: string, supply: number): void {
  tokenSupply.set(playerId, supply);
  if (!holderRegistry.has(playerId)) {
    holderRegistry.set(playerId, new Map());
  }
}

/** Reset stub state between tests. */
export function _stubReset(): void {
  holderRegistry.clear();
  tokenSupply.clear();
}

// ── Validation schemas ────────────────────────────────────────────────────────

const buyTokenSchema = z.object({
  amount: z.number().int().min(1, 'amount must be at least 1'),
  buyerWallet: z.string().min(1, 'buyerWallet is required'),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function featureFlagGuard(res: Response): boolean {
  if (!isFeatureEnabled(FeatureFlags.PLAYER_TOKENS)) {
    res.status(404).json({
      success: false,
      error: 'Player token endpoints are not enabled on this platform.',
    });
    return false;
  }
  return true;
}

// ── GET /api/players/:playerId/tokens ─────────────────────────────────────────

/**
 * Return the holder list and per-holder token balances for a player.
 *
 * Response shape:
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "playerId": "42",
 *     "totalSupply": 1000,
 *     "soldTokens": 300,
 *     "holders": [{ "holder": "G...", "tokens": 150 }]
 *   }
 * }
 * ```
 */
export function getPlayerTokenHolders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    if (!featureFlagGuard(res)) return;

    const { playerId } = req.params;

    const supply = tokenSupply.get(playerId);
    if (supply === undefined) {
      res.status(404).json({ success: false, error: 'No tokens have been issued for this player.' });
      return;
    }

    const holders = holderRegistry.get(playerId) ?? new Map<string, number>();
    let soldTokens = 0;
    const holderList: Array<{ holder: string; tokens: number }> = [];

    for (const [holder, tokens] of holders.entries()) {
      holderList.push({ holder, tokens });
      soldTokens += tokens;
    }

    res.json({
      success: true,
      data: {
        playerId,
        totalSupply: supply,
        soldTokens,
        holders: holderList,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── POST /api/players/:playerId/tokens/buy ────────────────────────────────────

/**
 * Purchase Player Tokens for a given player (stub).
 *
 * Body: `{ amount: number, buyerWallet: string }`
 *
 * Response shape:
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "playerId": "42",
 *     "buyerWallet": "G...",
 *     "amount": 10,
 *     "newBalance": 10
 *   }
 * }
 * ```
 */
export function buyPlayerToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    if (!featureFlagGuard(res)) return;

    const { playerId } = req.params;

    const parsed = buyTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors.map((e) => e.message).join('; '),
      });
      return;
    }

    const { amount, buyerWallet } = parsed.data;

    const supply = tokenSupply.get(playerId);
    if (supply === undefined) {
      res.status(404).json({ success: false, error: 'No tokens have been issued for this player.' });
      return;
    }

    const holders = holderRegistry.get(playerId) ?? new Map<string, number>();
    const currentSold = Array.from(holders.values()).reduce((a, b) => a + b, 0);
    const remaining = supply - currentSold;

    if (amount > remaining) {
      res.status(400).json({
        success: false,
        error: `Insufficient token supply. Requested ${amount}, available ${remaining}.`,
      });
      return;
    }

    const prev = holders.get(buyerWallet) ?? 0;
    const newBalance = prev + amount;
    holders.set(buyerWallet, newBalance);
    holderRegistry.set(playerId, holders);

    logger.info(`[playerToken] playerId=${playerId} buyer=${buyerWallet} amount=${amount} newBalance=${newBalance}`);

    res.json({
      success: true,
      data: {
        playerId,
        buyerWallet,
        amount,
        newBalance,
      },
    });
  } catch (err) {
    next(err);
  }
}
