import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { upsertScoutNote, getScoutNote, getScoutNotes } from '../db';
import { isValidStellarAddress } from '../utils/stellarAddress';
import { sanitizeInput } from '../utils/sanitizer';
import { sendForbidden } from '../utils/authError';
import { logger } from '../utils/logger';

// ─── Validation ────────────────────────────────────────────────────────────────

export const upsertNoteSchema = z.object({
  note: z.string().min(1, 'Note text is required').max(10_000, 'Note must be 10 000 characters or fewer'),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate that the authenticated account owns the wallet param and that the
 * wallet address is a valid Stellar address.  Returns false and sends the
 * appropriate error response when validation fails.
 */
function validateWalletOwnership(req: Request, res: Response): boolean {
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

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * PUT /api/scouts/:wallet/notes/:playerId
 *
 * Create or update a private note for the authenticated scout on the given player.
 * Uses upsert semantics — upserting twice for the same player updates in place.
 *
 * @auth Bearer (scout role, wallet must match authenticated account)
 */
export async function putScoutNote(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!validateWalletOwnership(req, res)) return;

    const { playerId } = req.params;
    const parsed = upsertNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid request body',
      });
      return;
    }

    const sanitizedNote = sanitizeInput(parsed.data.note);
    const now = Math.floor(Date.now() / 1000);

    upsertScoutNote({
      scout_wallet: req.params.wallet,
      player_id: playerId,
      note_text: sanitizedNote,
      updated_at: now,
    });

    logger.info({ scout: req.params.wallet, playerId, action: 'scout_note_upserted' });

    res.status(200).json({
      success: true,
      data: {
        scout_wallet: req.params.wallet,
        player_id: playerId,
        note: sanitizedNote,
        updated_at: now,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/scouts/:wallet/notes/:playerId
 *
 * Retrieve the authenticated scout's private note for a specific player.
 * Returns 404 when no note exists yet.
 *
 * @auth Bearer (scout role, wallet must match authenticated account)
 */
export async function getScoutNoteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!validateWalletOwnership(req, res)) return;

    const { playerId } = req.params;
    const row = getScoutNote(req.params.wallet, playerId);

    if (!row) {
      res.status(404).json({ success: false, error: 'Note not found' });
      return;
    }

    res.json({
      success: true,
      data: {
        scout_wallet: row.scout_wallet,
        player_id: row.player_id,
        note: row.note_text,
        updated_at: row.updated_at,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/scouts/:wallet/notes
 *
 * List all private notes for the authenticated scout, newest-first.
 *
 * @auth Bearer (scout role, wallet must match authenticated account)
 */
export async function listScoutNotesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!validateWalletOwnership(req, res)) return;

    const rows = getScoutNotes(req.params.wallet);

    res.json({
      success: true,
      data: rows.map((r) => ({
        scout_wallet: r.scout_wallet,
        player_id: r.player_id,
        note: r.note_text,
        updated_at: r.updated_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}
