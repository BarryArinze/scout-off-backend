import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { queryEvents, queryPlayers } from "../db";
import { ProgressLevel } from "../types";

const recQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  minTier: z.coerce.number().int().min(0).max(3).optional(),
});

function scoreMatch(
  region: string | null,
  position: string | null,
  pref: {
    region: string | null;
    position: string | null;
  },
): number {
  let score = 0;
  if (pref.region && region && pref.region === region) score += 5;
  if (pref.position && position && pref.position === position) score += 3;
  return score;
}

/**
 * GET /api/scouts/:wallet/recommendations
 *
 * Requires scout authentication.
 */
export async function getScoutRecommendations(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { wallet } = req.params;
    const parsed = recQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          success: false,
          error: parsed.error.errors[0]?.message ?? "Invalid query",
        });
      return;
    }

    const pageSize = parsed.data.pageSize ?? 20;
    const minTier = parsed.data.minTier as ProgressLevel | undefined;

    // Unlock history is derived from indexed on-chain events.
    const unlockedEvents = queryEvents("contact_unlocked").filter(
      (e) => e.payload.scout === wallet,
    );
    const unlockedPlayerIds = new Set<string>(
      unlockedEvents.map((e) => String(e.payload.player_id)),
    );

    // Derive preferences from the scout's unlocked contacts.
    // If no history exists, fall back to general population ordering.
    const regionCounts = new Map<string, number>();
    const positionCounts = new Map<string, number>();

    const allPlayers = await queryPlayers({ includeDeactivated: true });
    for (const ev of unlockedEvents) {
      const playerId = String(ev.payload.player_id);
      // We only have player position/region from the players table.
      // Use queryPlayers as a fallback later; here we just count based on player row.
      const playerRow = allPlayers.find((p) => p.player_id === playerId);
      if (!playerRow) continue;
      if (playerRow.region)
        regionCounts.set(
          playerRow.region,
          (regionCounts.get(playerRow.region) ?? 0) + 1,
        );
      if (playerRow.position)
        positionCounts.set(
          playerRow.position,
          (positionCounts.get(playerRow.position) ?? 0) + 1,
        );
    }

    const topRegion =
      [...regionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const topPosition =
      [...positionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    // Candidate pool: prefer filtering by top preferences, then backfill if needed.
    const candidatesA = await queryPlayers({
      region: topRegion ?? undefined,
      position: topPosition ?? undefined,
      minTier,
    });

    const candidates = candidatesA.length
      ? candidatesA
      : await queryPlayers({
          minTier,
        });

    const filtered = candidates
      .filter((p) => !unlockedPlayerIds.has(p.player_id))
      .map((p) => ({
        player_id: p.player_id,
        wallet: p.wallet,
        position: p.position,
        region: p.region,
        metadataUri: p.metadata_uri,
        progress_level: p.progress_level,
        created_at: p.created_at,
        _score: scoreMatch(p.region, p.position, {
          region: topRegion,
          position: topPosition,
        }),
      }))
      .sort(
        (a, b) =>
          b._score - a._score || (b.created_at ?? 0) - (a.created_at ?? 0),
      );

    res.json({
      success: true,
      data: filtered.slice(0, pageSize).map(({ _score, ...rest }) => rest),
      meta: {
        pageSize,
        preferredRegion: topRegion,
        preferredPosition: topPosition,
        unlockedCount: unlockedPlayerIds.size,
      },
    });
  } catch (err) {
    next(err);
  }
}
