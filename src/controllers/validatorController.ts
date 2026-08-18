import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { pinJson } from '../services/ipfs';
import { getPendingMilestones as getPendingMilestonesFromDb } from '../db';
import { invalidateMilestoneCache } from '../services/cache';
import { recordAudit } from '../utils/audit';
import { isValidEvidenceUri } from '../utils/uriValidator';

export { isValidEvidenceUri };

export const milestoneSchema = z.object({
  playerId: z.string().min(1),
  milestoneType: z.enum(['identity', 'performance', 'trial_offer']),
  evidenceUri: z.string().min(1).refine(isValidEvidenceUri, 'evidenceUri must be a valid IPFS (ipfs://) or HTTPS URI'),
});

export const pendingQuerySchema = z.object({
  region: z.string().optional(),
  position: z.string().optional(),
  playerId: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/** POST /api/validators/milestone */
function getCorrelationId(req: Request): string {
  return String(req.headers?.['x-correlation-id'] ?? req.headers?.['correlation-id'] ?? 'none');
}

export async function submitMilestoneEvidence(req: Request, res: Response, next: NextFunction) {
  try {
    const { playerId, milestoneType, evidenceUri } = milestoneSchema.parse(req.body);
    const evidenceCid = await pinJson({ playerId, milestoneType, evidenceUri });
    // Invalidate milestone + player cache so updated progress tier is reflected
    await invalidateMilestoneCache(playerId);

    const validatorWallet = req.account ?? 'unknown';
    const correlationId = getCorrelationId(req);
    logger.info(
      `[validator] action=submit_milestone validator=${validatorWallet} playerId=${playerId} milestoneType=${milestoneType} evidenceCid=${evidenceCid} correlationId=${correlationId}`
    );

    await recordAudit(validatorWallet, 'milestone_submitted', { playerId, milestoneType, evidenceCid }, `correlationId=${correlationId}`);

    res.status(201).json({ success: true, data: { evidenceCid } });
  } catch (err) {
    next(err);
  }
}

/** GET /api/validators/milestones/pending or /api/validators/:wallet/milestones/pending */
export async function getPendingMilestones(req: Request, res: Response, next: NextFunction) {
  try {
    const { region, position, playerId, page, pageSize } = pendingQuerySchema.parse(req.query);
    const validatorWallet = req.params.wallet || req.account;
    const { data, total } = await getPendingMilestonesFromDb({
      validatorWallet: validatorWallet,
      region,
      position,
      playerId,
      page,
      pageSize,
    });

    // Transform to the desired output format
    const milestones = data.map((m) => ({
      milestoneId: m.milestone_id,
      playerId: m.player_id,
      milestoneType: m.milestone_type,
      evidenceUri: m.evidence_uri,
      submittedAt: m.submitted_at,
    }));

    const currentValidatorWallet = req.account ?? 'unknown';
    await recordAudit(
      currentValidatorWallet,
      'pending_milestones_viewed', 
      { 
        region: region ?? null, 
        position: position ?? null,
        validatorWallet,
        pendingCount: total,
      }, 
      'pending milestones viewed'
    );

    res.json({ 
      success: true, 
      data: milestones, 
      total, 
      page: page || 1, 
      pageSize: pageSize || 20 
    });
  } catch (err) {
    next(err);
  }
}
