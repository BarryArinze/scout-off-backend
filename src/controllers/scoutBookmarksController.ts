/**
 * Scout Bookmarks Controller (#487)
 *
 * Allows scouts to bookmark players for later follow-up.  Bookmark lists are
 * per-scout and return full player profile summaries (not bare ids) so the
 * response is consistent with the player list endpoint.
 */
import { Request, Response, NextFunction } from 'express';
import {
  getPlayerById,
  insertBookmark,
  deleteBookmark,
  getBookmarksByScout,
  ScoutBookmarkRow,
  PlayerRow,
} from '../db';
import { isValidStellarAddress } from '../utils/stellarAddress';
import { sendForbidden } from '../utils/authError';
import { getTierMeta } from '../utils/tier';
import { logger } from '../utils/logger';

// ─── Ownership guard ──────────────────────────────────────────────────────────

function assertWalletOwnership(req: Request, res: Response): boolean {
  const { wallet } = req.params;
  if (!isValidStellarAddress(wallet)) {
    res.status(400).json({ success: false, error: 'Invalid Stellar address' });
    return false;
  }
  if (req.account !== wallet) {
    sendForbidden(res, 'Forbidden: wallet mismatch');
    return false;
  }
  return true;
}

// ─── Serialization (mirrors filterPlayers in playerController.ts) ─────────────

function serializePlayer(row: PlayerRow): Record<string, unknown> {
  const { tierName, tierDescription } = getTierMeta(row.progress_level as number);
  return {
    player_id: row.player_id,
    wallet: row.wallet,
    position: row.position,
    region: row.region,
    metadataUri: row.metadata_uri,
    progress_level: row.progress_level,
    created_at: row.created_at,
    tierName,
    tierDescription,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/bookmarks/:playerId
 *
 * Bookmark a player.  Idempotent — bookmarking an already-bookmarked player
 * returns 200 without creating a duplicate row.
 * Returns 404 when the player does not exist in the local database.
 */
export async function addBookmark(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!assertWalletOwnership(req, res)) return;

    const { playerId } = req.params;

    // Verify the player exists
    const player = getPlayerById(playerId);
    if (!player) {
      res.status(404).json({ success: false, error: 'Player not found' });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const inserted = insertBookmark({
      scout_wallet: req.params.wallet,
      player_id: playerId,
      created_at: now,
    });

    if (inserted) {
      logger.info({ scout: req.params.wallet, playerId, action: 'bookmark_added' });
    }

    res.status(200).json({
      success: true,
      data: {
        scout_wallet: req.params.wallet,
        player_id: playerId,
        created_at: now,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/scouts/:wallet/bookmarks/:playerId
 *
 * Remove a bookmark.  Returns 404 when the bookmark does not exist.
 */
export async function removeBookmark(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!assertWalletOwnership(req, res)) return;

    const { playerId } = req.params;
    const removed = deleteBookmark(req.params.wallet, playerId);

    if (!removed) {
      res.status(404).json({ success: false, error: 'Bookmark not found' });
      return;
    }

    logger.info({ scout: req.params.wallet, playerId, action: 'bookmark_removed' });

    res.json({ success: true, data: { removed: true, player_id: playerId } });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/scouts/:wallet/bookmarks
 *
 * List all bookmarked players for the authenticated scout.
 * Returns full player profile summaries (same shape as the player list endpoint).
 */
export async function listBookmarks(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!assertWalletOwnership(req, res)) return;

    const bookmarks: ScoutBookmarkRow[] = getBookmarksByScout(req.params.wallet);

    // Enrich with full player data
    const enriched = bookmarks
      .map((b) => {
        const player = getPlayerById(b.player_id);
        if (!player) return null;
        return {
          ...serializePlayer(player),
          bookmarked_at: b.created_at,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);

    res.json({ success: true, data: enriched });
  } catch (err) {
    next(err);
  }
}
