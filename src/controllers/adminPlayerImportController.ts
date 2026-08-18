import { Request, Response, NextFunction } from 'express';
import { createId } from '@paralleldrive/cuid2';
import { sanitizeInput } from '../utils/sanitizer';
import { pinJson } from '../services/ipfs';
import { insertOrUpdatePlayer } from '../db';
import { dispatchEventWebhook } from '../services/webhooks';
import { invalidatePlayerCache } from '../services/cache';
import { registerSchema } from './playerController';
import { logger } from '../utils/logger';
import { logAuditEvent } from '../services/audit';
import { ErrorCode } from '../utils/errorCodes';
import config from '../config';

export type ImportPlayerResultStatus = 'success' | 'error';

export interface ImportPlayerResult {
  /** 1-based position of this entry within the submitted batch. */
  row: number;
  status: ImportPlayerResultStatus;
  playerId?: string;
  wallet?: string;
  metadataUri?: string;
  error?: string;
}

/**
 * Parse a CSV text body into raw row objects for player import.
 *
 * Columns: wallet,position,region,metadataUri
 *
 * Lines beginning with # or empty lines are ignored. A header row whose
 * first token is the literal "wallet" (case-insensitive) is silently skipped.
 * Each row is handed to registerSchema unvalidated — parsePlayerCsvBody only
 * splits columns, it doesn't decide whether a row is well-formed.
 */
export function parsePlayerCsvBody(text: string): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols[0].toLowerCase() === 'wallet') continue;
    const [wallet, position, region, metadataUri] = cols;
    rows.push({
      wallet: wallet ?? '',
      position: position ?? '',
      region: region ?? '',
      metadataUri: metadataUri ?? '',
    });
  }
  return rows;
}

/**
 * Process a batch of raw player entries, one at a time.
 *
 * Each entry is validated with the exact registerSchema used by
 * POST /api/players/register, then run through the same
 * sanitize → pin (if needed) → upsert → dispatch webhook path as the
 * single-registration endpoint, so no registration logic is duplicated.
 * A failure on one row (bad schema, IPFS pin failure, etc.) is captured in
 * that row's result and does not stop the remaining rows from processing.
 */
export async function processPlayerImportBatch(
  entries: unknown[],
): Promise<ImportPlayerResult[]> {
  const results: ImportPlayerResult[] = [];

  for (let i = 0; i < entries.length; i++) {
    const row = i + 1;
    const parsed = registerSchema.safeParse(entries[i]);
    if (!parsed.success) {
      results.push({
        row,
        status: 'error',
        error: parsed.error.errors[0]?.message ?? 'Invalid entry',
      });
      continue;
    }

    const { wallet } = parsed.data;
    try {
      const sanitizedPosition = sanitizeInput(parsed.data.position);
      const sanitizedRegion = sanitizeInput(parsed.data.region);
      const metadataUri =
        'metadataUri' in parsed.data
          ? parsed.data.metadataUri
          : await pinJson({
              wallet,
              position: sanitizedPosition,
              region: sanitizedRegion,
              ...parsed.data.metadata,
            });

      const playerId = createId();
      insertOrUpdatePlayer({
        player_id: playerId,
        wallet,
        position: sanitizedPosition,
        region: sanitizedRegion,
        metadata_uri: metadataUri,
        created_at: Math.floor(Date.now() / 1000),
      });

      await dispatchEventWebhook('player_registered', {
        player_id: playerId,
        wallet,
        position: sanitizedPosition,
        region: sanitizedRegion,
        metadataUri,
      });

      results.push({ row, status: 'success', playerId, wallet, metadataUri });
    } catch (err) {
      results.push({ row, status: 'error', wallet, error: (err as Error).message });
    }
  }

  return results;
}

/**
 * POST /api/admin/players/import
 *
 * Accepts either:
 *   - JSON body:  { players: [{ wallet, position, region, metadata|metadataUri }, …] }
 *   - CSV body:   Content-Type: text/csv or text/plain, rows: wallet,position,region,metadataUri
 *
 * Each row is validated with the same registerSchema as the single-player
 * registration endpoint and processed independently, so one invalid or
 * failing row doesn't abort the whole batch.
 *
 * @response 200 { success: true, data: { results, summary: { total, succeeded, failed } } }
 * @response 400 { success: false, error: string } - Empty/unparseable body or batch too large
 * @auth Bearer (admin role required)
 */
export async function importPlayers(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    const contentType = (req.headers['content-type'] ?? '').toLowerCase();

    let entries: unknown[];

    if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      const rawBody = req.body as string;
      if (typeof rawBody !== 'string' || !rawBody.trim()) {
        res.status(400).json({ success: false, error: 'CSV body is empty', code: ErrorCode.VALIDATION_ERROR });
        return;
      }
      entries = parsePlayerCsvBody(rawBody);
    } else {
      const jsonBody = req.body as { players?: unknown };
      if (!jsonBody || !Array.isArray(jsonBody.players)) {
        res.status(400).json({
          success: false,
          error: 'Request body must contain a "players" array or use Content-Type: text/csv',
          code: ErrorCode.VALIDATION_ERROR,
        });
        return;
      }
      entries = jsonBody.players;
    }

    if (entries.length === 0) {
      res.status(400).json({ success: false, error: 'No player entries found in request', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    if (entries.length > config.playerImport.maxBatchSize) {
      res.status(400).json({
        success: false,
        error: `Batch exceeds maximum size of ${config.playerImport.maxBatchSize} entries`,
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const results = await processPlayerImportBatch(entries);

    const succeeded = results.filter((r) => r.status === 'success').length;
    const failed = results.filter((r) => r.status === 'error').length;

    if (succeeded > 0) {
      await invalidatePlayerCache();
    }

    logger.info(
      `[admin] action=import_players admin=${adminWallet} total=${results.length} succeeded=${succeeded} failed=${failed}`,
    );

    await logAuditEvent({
      action: 'bulk_player_import',
      adminWallet,
      queryParams: { total: results.length, succeeded, failed },
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    res.status(200).json({
      success: true,
      data: {
        results,
        summary: {
          total: results.length,
          succeeded,
          failed,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}
