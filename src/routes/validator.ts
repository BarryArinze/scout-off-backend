import { Router } from 'express';
import {
  submitMilestoneEvidence,
  getPendingMilestones,
  milestoneSchema,
  pendingQuerySchema,
  approveBulkMilestones,
  bulkApproveSchema,
} from '../controllers/validatorController';
import { requireRole } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimit';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

const router = Router();

const milestoneRateLimit = rateLimit({
  name: 'validator-milestone',
  windowMs: Number(process.env.MILESTONE_RATE_WINDOW_MS) || 60_000,
  max: Number(process.env.MILESTONE_RATE_MAX) || 10,
});

/**
 * POST /api/validators/milestone
 *
 * Submit evidence for a player milestone. `evidenceUri` may be an
 * `https://` URL (downloaded and re-pinned to IPFS) or an `ipfs://` CID
 * (recorded directly). Invalidates the player's milestone cache on success.
 *
 * @body { playerId: string, milestoneType: 'identity'|'performance'|'trial_offer', evidenceUri: string }
 * @response 201 { success: true, data: { evidenceCid: string } }
 * @response 400 { success: false, error: string } - Invalid body
 * @response 413 { success: false, error: string } - Remote evidence file too large
 * @response 422 { success: false, error: string } - Remote evidence has an unsupported content type
 * @auth Bearer (validator role required)
 */
router.route('/milestone')
  .post(milestoneRateLimit, requireRole('validator'), validateBody(milestoneSchema), submitMilestoneEvidence)
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/validators/milestones/pending
 *
 * List pending milestones for the authenticated validator, optionally
 * filtered by region/position/playerId and paginated.
 *
 * @response 200 { success: true, data: PendingMilestone[], total, page, pageSize }
 * @auth Bearer (validator role required)
 */
router.route('/milestones/pending')
  .get(requireRole('validator'), validateQuery(pendingQuerySchema), getPendingMilestones)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/validators/:wallet/milestones/pending
 *
 * Same as GET /api/validators/milestones/pending, scoped explicitly to the
 * given validator wallet rather than the caller's own token.
 *
 * @param wallet {string} - Validator's Stellar public key
 * @response 200 { success: true, data: PendingMilestone[], total, page, pageSize }
 * @auth Bearer (validator role required)
 */
router.route('/:wallet/milestones/pending')
  .get(requireRole('validator'), validateQuery(pendingQuerySchema), getPendingMilestones)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/validators/milestones/approve-bulk
 *
 * Approve a batch of milestones assigned to the authenticated validator in
 * one call. Each ID is processed independently — a failure on one does not
 * abort the batch; per-ID outcomes are returned in `data`.
 *
 * @body { milestoneIds: string[] } - At least one ID required
 * @response 200 { success: true, data: Array<{ milestoneId, status: 'approved'|'invalid'|'unauthorized'|'error', error? }> }
 * @response 400 { success: false, error: string } - Empty milestoneIds
 * @auth Bearer (validator role required)
 */
router.route('/milestones/approve-bulk')
  .post(requireRole('validator'), validateBody(bulkApproveSchema), approveBulkMilestones)
  .all(methodNotAllowed(['POST']));

export default router;
