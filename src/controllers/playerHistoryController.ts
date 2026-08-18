import { Request, Response, NextFunction } from "express";
import { getPlayerProfileHistory } from "../db";
import { z } from "zod";
import { ApiResponse } from "../types";

const playerIdSchema = z.string().min(1);

export interface PlayerProfileHistoryItem {
  metadataUri: string;
  changedAt: number;
  txHash: string;
}

/**
 * GET /api/players/:playerId/history
 */
export async function getPlayerHistory(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const playerId = playerIdSchema.parse(req.params.playerId);
    const rows = await getPlayerProfileHistory(playerId);

    const body: ApiResponse<PlayerProfileHistoryItem[]> = {
      success: true,
      data: rows.map((r) => ({
        metadataUri: r.metadata_uri,
        changedAt: r.changed_at,
        txHash: r.tx_hash,
      })),
    };

    res.json(body);
  } catch (err) {
    next(err);
  }
}
