/**
 * Player data anonymization controller (GDPR right-to-erasure).
 *
 * POST /api/players/:playerId/anonymize
 *   - Requires player JWT + owner check.
 *   - Scrubs PII from off-chain stores this backend controls:
 *       • `players` row: nullifies wallet, position, region, metadata_uri
 *       • `player_profile_history`: removes all rows
 *       • `pending_milestones`: cancels all
 *       • `profile_views`, `contact_unlocks`: deletes rows referencing player
 *       • `trial_offers`: deletes rows referencing player
 *   - Unpins IPFS content the backend pinned (metadata, evidence, etc.).
 *   - Deactivates the player (is_active = 0).
 *   - Records an audit log entry so the anonymization event itself is tracked.
 *   - Does NOT erase on-chain Soroban contract state (immutable by design).
 *     See docs/data-privacy.md for the full boundary description.
 */

import { Request, Response, NextFunction } from 'express';
import {
  getPlayerById,
  cancelPendingMilestonesForPlayer,
  getPlayerProfileHistory,
  getDb,
} from '../db';
import { invalidatePlayerCache } from '../services/cache';
import { unpinCid } from '../services/ipfs';
import { logAuditEvent } from '../services/audit';
import { logger } from '../utils/logger';
import { playerIdSchema } from '../utils/playerIdValidator';
import { ErrorCode } from '../utils/errorCodes';

const ANONYMIZED_PLACEHOLDER = '[anonymized]';

// ─── POST /api/players/:playerId/anonymize ──────────────────────────────────

export async function anonymizePlayer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // ── Validate playerId path param ─────────────────────────────────────────
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({
        success: false,
        error: idResult.error.errors[0]?.message ?? 'Invalid playerId',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }
    const playerId = req.params.playerId;

    // ── Fetch player ─────────────────────────────────────────────────────────
    const player = getPlayerById(playerId);
    if (!player) {
      res.status(404).json({
        success: false,
        error: 'Player not found',
        code: ErrorCode.NOT_FOUND,
      });
      return;
    }

    // ── Collect CIDs to unpin ────────────────────────────────────────────────
    const cidsToUnpin: string[] = [];
    if (player.metadata_uri) cidsToUnpin.push(player.metadata_uri);
    const historyRows = getPlayerProfileHistory(playerId);
    for (const row of historyRows) {
      if (row.metadata_uri) cidsToUnpin.push(row.metadata_uri);
    }

    // ── Scrub DB PII (single transaction for consistency) ────────────────────
    const db = getDb();
    db.transaction(() => {
      // Anonymize the players row (keep player_id + progress_level for aggregate stats)
      db.prepare(
        `UPDATE players
         SET wallet = ?,
             position = NULL,
             region = NULL,
             metadata_uri = NULL,
             is_active = 0,
             deactivation_reason = ?
         WHERE player_id = ?`
      ).run(ANONYMIZED_PLACEHOLDER, 'GDPR anonymization request', playerId);

      // Delete profile history (contains metadata_uri + tx_hash — PII)
      db.prepare('DELETE FROM player_profile_history WHERE player_id = ?').run(playerId);

      // Cancel pending milestones (evidence_uri — PII)
      cancelPendingMilestonesForPlayer(playerId);

      // Delete profile views (behavioral PII linking scouts → player)
      db.prepare('DELETE FROM profile_views WHERE player_id = ?').run(playerId);

      // Delete contact unlocks referencing this player
      db.prepare('DELETE FROM contact_unlocks WHERE player_id = ?').run(playerId);

      // Delete trial offers
      db.prepare('DELETE FROM trial_offers WHERE player_id = ?').run(playerId);

      // Delete scout bookmarks referencing this player
      db.prepare('DELETE FROM scout_bookmarks WHERE player_id = ?').run(playerId);
    })();

    // ── Invalidate caches ────────────────────────────────────────────────────
    await invalidatePlayerCache(playerId);

    // ── Unpin IPFS content (best-effort — non-blocking) ──────────────────────
    const uniqueCids = [...new Set(cidsToUnpin)];
    for (const cid of uniqueCids) {
      try {
        await unpinCid(cid);
      } catch (err) {
        // Log but don't fail the request — pins may already be gone or unreachable
        logger.warn('[anonymize] IPFS unpin failed', { cid, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── Audit log (append-only; does not contain PII — only player_id) ──────
    logAuditEvent({
      action: 'player_anonymized',
      timestamp: new Date().toISOString(),
      queryParams: {
        player_id: playerId,
        cids_unpinned: uniqueCids.length,
        requester: req.account ?? 'unknown',
      },
    });

    logger.info('[anonymize] Player data anonymized', { playerId, cidsUnpinned: uniqueCids.length });

    res.json({
      success: true,
      message: 'Player data has been anonymized. On-chain data is immutable and cannot be erased — see docs/data-privacy.md for details.',
      anonymized: {
        dbFieldsScrubbed: true,
        profileHistoryDeleted: historyRows.length,
        ipfsCidsUnpinned: uniqueCids.length,
      },
    });
  } catch (err) {
    next(err);
  }
}
