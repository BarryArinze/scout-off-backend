import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { sanitizeInput } from "../utils/sanitizer";
import { createId } from "@paralleldrive/cuid2";
import { z } from "zod";
import { CID_REGEX } from "../utils/cidValidator";
import { pinJson } from "../services/ipfs";
import { serializeIpfsResult } from "../utils/ipfsSerializer";
import {
  queryEvents,
  getPlayerById,
  insertPlayerProfileHistory,
  queryPlayers,
  countPlayers,
  insertOrUpdatePlayer,
  deactivatePlayer,
  reactivatePlayer,
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
    await invalidatePlayerCache();

    // Write to DB immediately so GET /players/:playerId returns 200 without
    // waiting for the indexer to process the blockchain event (#282).
    const playerId = createId();
    insertOrUpdatePlayer({
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
    let data = await cacheGet<Record<string, unknown>>(cacheKey);
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
        is_active: row.is_active,
        tierName,
        tierDescription,
      };
      await cacheSet(cacheKey, data);
    }

    if (data.is_active === 0) {
      const isOwner = req.account && (req.account === data.player_id || req.account === data.wallet);
      const isAdmin = req.role === 'admin';
      if (!isOwner && !isAdmin) {
        res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
        return;
      }
    }

    const etag = `"${createHash("sha1").update(JSON.stringify(data)).digest("hex")}"`;
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
    res.set("ETag", etag);
    res.json({ success: true, data });
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
      // minTier is a valid integer but outside the 0–3 range → semantic error (422).
      // A non-integer or wrong type is caught by Zod as a format error (400).
      const isRangeError = typeof tierResult.error === 'string' && tierResult.error.includes('out of range');
      res.status(isRangeError ? 422 : 400).json({ success: false, error: tierResult.error, code: ErrorCode.VALIDATION_ERROR });
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

    const cached = await cacheGet<FilterPlayersResult>(cacheKey);
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
    await cacheSet(cacheKey, result);

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
    await invalidatePlayerCache(playerId);

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

    const player = getPlayerById(playerId);
    if (!player) {
      res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
      return;
    }
    if (player.is_active === 0) {
      const isOwner = req.account && (req.account === player.player_id || req.account === player.wallet);
      const isAdmin = req.role === 'admin';
      if (!isOwner && !isAdmin) {
        res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
        return;
      }
    }

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
    const indexedMilestones = queryEvents("milestone_approved")
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

/** POST /api/players/:playerId/deactivate */
export async function deactivatePlayerEndpoint(
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
    const row = getPlayerById(playerId);
    if (!row) {
      res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
      return;
    }
    deactivatePlayer(playerId);
    await invalidatePlayerCache(playerId);
    res.json({ success: true, message: "Player profile deactivated successfully" });
  } catch (err) {
    next(err);
  }
}

/** POST /api/players/:playerId/reactivate */
export async function reactivatePlayerEndpoint(
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
    const row = getPlayerById(playerId);
    if (!row) {
      res.status(404).json({ success: false, error: "Player not found", code: ErrorCode.PLAYER_NOT_FOUND });
      return;
    }
    reactivatePlayer(playerId);
    await invalidatePlayerCache(playerId);
    res.json({ success: true, message: "Player profile reactivated successfully" });
  } catch (err) {
    next(err);
  }
}
