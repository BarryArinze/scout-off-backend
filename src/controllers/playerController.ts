import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { sanitizeInput } from "../utils/sanitizer";
import { createId } from "@paralleldrive/cuid2";
import { z } from "zod";
import { CID_REGEX } from "../utils/cidValidator";
import { pinJson } from "../services/ipfs";
import { serializeIpfsResult } from "../utils/ipfsSerializer";
import {
  getEvents,
  getPlayerById,
  insertPlayerProfileHistory,
  queryPlayers,
  countPlayers,
  upsertPlayer,
  recordProfileView,
  getLastProfileView,
  getProfileViewCount,
  getUniqueViewerCount,
  getContactUnlockCount,
} from "../db";

import { queryMilestones, updateProfile } from "../services/stellar";
import { cacheGet, cacheSet, invalidatePlayerCache } from "../services/cache";
import { ApiResponse } from "../types";
import { ErrorCode } from "../utils/errorCodes";
import { getTierMeta } from "../utils/tier";
import { validateMinTier } from "../utils/minTierValidator";
import { normalizePosition } from "../utils/positionAliases";
import { dispatchEventWebhook } from "../services/webhooks";
import { enrichPlayerResult } from "../utils/searchEnrichment";
import { playerIdSchema } from "../utils/playerIdValidator";
import { recordAudit } from "../utils/audit";

const baseRegistrationSchema = z.object({
  wallet: z.string().min(56).max(56),
  position: z.string().min(1),
  region: z.string().min(1),
});

const metadataSchema = z.record(z.unknown());
const metadataUriSchema = z
  .string()
  .regex(CID_REGEX, "metadataUri must be a valid CID");

export const registerSchema = z.union([
  baseRegistrationSchema.extend({ metadata: metadataSchema }),
  baseRegistrationSchema.extend({ metadataUri: metadataUriSchema }),
]);

export type RegisterPlayerRequest = z.infer<typeof registerSchema>;

export const filterSchema = z.object({
  region: z.string().optional(),
  position: z.string().optional(),
  minTier: z.coerce.number().int().min(0).max(3).optional(),
  sortBy: z.enum(['tier', 'region']).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** POST /api/players/register */
export async function registerPlayer(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = registerSchema.parse(req.body);

    // Ensure the wallet in the request body belongs to the authenticated account.
    // Without this check a player could register a profile under another player's address.
    if (parsed.wallet !== req.account) {
      res.status(403).json({ success: false, error: 'wallet must match authenticated account' });
      return;
    }

    const sanitizedPosition = sanitizeInput(parsed.position);
    const sanitizedRegion = sanitizeInput(parsed.region);
    const metadataUri =
      "metadataUri" in parsed
        ? parsed.metadataUri
        : await pinJson({
            wallet: parsed.wallet,
            position: sanitizedPosition,
            region: sanitizedRegion,
            ...parsed.metadata,
          });

    // Invalidate player search cache so new profile appears in results
    invalidatePlayerCache();

    // Write to DB immediately so GET /players/:playerId returns 200 without
    // waiting for the indexer to process the blockchain event (#282).
    const playerId = createId();
    upsertPlayer({
      player_id: playerId,
      wallet: parsed.wallet,
      position: sanitizedPosition,
      region: sanitizedRegion,
      metadata_uri: metadataUri,
      created_at: Math.floor(Date.now() / 1000),
    });

    await dispatchEventWebhook("player_registered", {
      player_id: playerId,
      wallet: parsed.wallet,
      position: sanitizedPosition,
      region: sanitizedRegion,
      metadataUri,
    });

    const ipfsResult = serializeIpfsResult(metadataUri, {
      wallet: parsed.wallet,
      position: sanitizedPosition,
      region: sanitizedRegion,
    });
    const body: ApiResponse<
      typeof ipfsResult & { playerId: string; metadataUri: string; gatewayUrl: string }
    > = {
      success: true,
      data: { ...ipfsResult, playerId, metadataUri, gatewayUrl: ipfsResult.uri },
    };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/players/:playerId */
export async function getPlayer(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({ success: false, error: idResult.error.errors[0]?.message ?? "Invalid playerId", code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const playerId = sanitizeInput(req.params.playerId);
    const cacheKey = `players:${playerId}`;
    let data = cacheGet<Record<string, unknown>>(cacheKey);
    if (!data) {
      const row = getPlayerById(playerId);
      if (!row) {
        res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
        return;
      }
      const { tierName, tierDescription } = getTierMeta(row.progress_level as number);
      data = {
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
      cacheSet(cacheKey, data);
    }

    const etag = `"${createHash("sha1").update(JSON.stringify(data)).digest("hex")}"`;
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    res.set("ETag", etag);
    res.json({ success: true, data });

    // Record profile view (non-blocking, after response is sent)
    // This is synchronous but happens after the response is queued
    recordProfileViewForRequest(req);
  } catch (err) {
    next(err);
  }
}

interface FilterPlayersResult {
  data: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/** GET /api/players?region=&position=&minTier= */
export async function filterPlayers(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const tierResult = validateMinTier(req.query.minTier);
    if (!tierResult.valid) {
      res.status(400).json({ success: false, error: tierResult.error, code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const minTier = tierResult.tier;
    const { region, position, page, pageSize } = filterSchema.parse(req.query);
    const sanitizedRegion = region ? sanitizeInput(region) : undefined;
    const sanitizedPosition = position ? sanitizeInput(position) : undefined;
    const normalizedPosition = sanitizedPosition
      ? normalizePosition(sanitizedPosition)
      : undefined;

    const cacheKey = `players:list:${JSON.stringify({
      region: sanitizedRegion ?? null,
      position: normalizedPosition ?? sanitizedPosition ?? null,
      minTier: minTier ?? null,
      page,
      pageSize,
    })}`;

    const cached = cacheGet<FilterPlayersResult>(cacheKey);
    if (cached) {
      res.json({ success: true, ...cached });
      return;
    }

    const rows = queryPlayers({
      region: sanitizedRegion,
      position: normalizedPosition ?? sanitizedPosition,
      minTier,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    const total = countPlayers({
      region: sanitizedRegion,
      position: normalizedPosition ?? sanitizedPosition,
      minTier,
    });
    const pages = Math.ceil(total / pageSize);
    const enriched = rows.map((row) => ({
      player_id: row.player_id,
      wallet: row.wallet,
      position: row.position,
      region: row.region,
      metadataUri: row.metadata_uri,
      progress_level: row.progress_level,
      created_at: row.created_at,
      ...enrichPlayerResult(row.progress_level),
    }));

    const result: FilterPlayersResult = { data: enriched, total, page, pageSize, pages };
    cacheSet(cacheKey, result);

    const scoutWallet = req.account ?? 'anonymous';
    recordAudit(scoutWallet, 'player_search', {
      region: sanitizedRegion ?? null,
      position: normalizedPosition ?? sanitizedPosition ?? null,
      minTier: minTier ?? null,
      page,
      pageSize,
      resultCount: total,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/** PUT /api/players/:playerId — profile owner only */
export const updatePlayerSchema = z.union([
  z.object({ metadata: z.record(z.unknown()) }),
  z.object({ metadataUri: metadataUriSchema }),
]);

export async function updatePlayer(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const playerId = sanitizeInput(req.params.playerId);
    const parsed = updatePlayerSchema.parse(req.body);
    const metadataUri =
      "metadata" in parsed
        ? await pinJson({ playerId, ...parsed.metadata })
        : parsed.metadataUri;
    const result = await updateProfile(playerId, metadataUri);

    // Append a profile version history row after the on-chain update succeeds.
    insertPlayerProfileHistory({
      player_id: playerId,
      metadata_uri: result.metadataUri,
      changed_at: Date.now(),
      tx_hash: result.transactionId,
    });

    // Bust the single-player cache so the next GET reflects the update.
    invalidatePlayerCache(playerId);

    res.status(200).json({
      success: true,
      data: {
        transactionId: result.transactionId,
        metadataUri: result.metadataUri,
      },
    });
  } catch (err) {
    next(err);
  }
}

const milestonesQuerySchema = z.object({
  sortBy: z.enum(["submittedAt", "approvedAt"]).default("submittedAt"),
  order: z.enum(["asc", "desc"]).default("asc"),
});

/** GET /api/players/:playerId/milestones */
export async function getPlayerMilestones(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({ success: false, error: idResult.error.errors[0]?.message ?? "Invalid playerId", code: ErrorCode.VALIDATION_ERROR });
      return;
    }
    const playerId = sanitizeInput(req.params.playerId);

    const parsed = milestonesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? "Invalid query parameters",
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }
    const { sortBy, order } = parsed.data;
    const indexedMilestones = getEvents("milestone_approved")
      .filter((e) => e.payload.player_id === playerId)
      .map((e) => ({ ...e.payload }));
    const onChainMilestones = await queryMilestones(playerId);
    const combined = [
      ...indexedMilestones,
      ...(onChainMilestones as unknown as Record<string, unknown>[]),
    ];
    combined.sort((a, b) => {
      const av = Number(a[sortBy] ?? 0);
      const bv = Number(b[sortBy] ?? 0);
      return order === "asc" ? av - bv : bv - av;
    });
    res.json({ success: true, data: combined });
  } catch (err) {
    next(err);
  }
}

// ─── Profile Analytics ─────────────────────────────────────────────────────

/**
 * Record a profile view from an authenticated scout.
 * Checks for self-views and deduplicates rapid consecutive views within a 5-minute window.
 * Errors are logged but do not interfere with the response.
 */
function recordProfileViewForRequest(req: Request): void {
  try {
    // Only record views from authenticated scouts
    if (!req.account) {
      return;
    }

    const playerId = req.params.playerId;
    const scoutWallet = req.account as string;

    // Get player to check for self-view
    const player = getPlayerById(playerId);
    if (!player) {
      // Player doesn't exist, skip recording
      return;
    }

    // Exclude self-views
    if (scoutWallet === player.wallet) {
      return;
    }

    // Check dedup window: 5 minutes (300 seconds)
    const lastViewAt = getLastProfileView(scoutWallet, playerId);
    const now = Math.floor(Date.now() / 1000);

    if (lastViewAt !== null && (now - lastViewAt) < 300) {
      // View within dedup window, skip recording
      return;
    }

    // Record the view
    recordProfileView({
      scout_wallet: scoutWallet,
      player_id: playerId,
      viewed_at: now,
      created_at: now,
    });
  } catch (err) {
    // Log error but don't re-throw; profile view recording is non-critical
    const message = err instanceof Error ? err.message : JSON.stringify(err);
    // eslint-disable-next-line no-console
    console.error(`[Profile View Recording Error] ${message}`, {
      playerId: req.params.playerId,
      scoutWallet: req.account,
    });
  }
}

/**
 * GET /api/players/:playerId/analytics
 * Return aggregated profile view and contact unlock analytics for the player (owner-only).
 */
export async function getPlayerAnalytics(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId);
    if (!idResult.success) {
      res.status(400).json({
        success: false,
        error: idResult.error.errors[0]?.message ?? "Invalid playerId",
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const playerId = sanitizeInput(req.params.playerId);

    // Verify player exists
    const player = getPlayerById(playerId);
    if (!player) {
      res.status(404).json({
        success: false,
        error: "Player not found",
        code: ErrorCode.PLAYER_NOT_FOUND,
      });
      return;
    }

    // Get aggregated metrics
    const viewCount = getProfileViewCount(playerId);
    const viewerCount = getUniqueViewerCount(playerId);
    const contactUnlockCount = getContactUnlockCount(playerId);
    const lastUpdated = Math.floor(Date.now() / 1000);

    res.json({
      success: true,
      data: {
        view_count: viewCount,
        viewer_count: viewerCount,
        contact_unlock_count: contactUnlockCount,
        lastUpdated,
      },
    });
  } catch (err) {
    next(err);
  }
}
