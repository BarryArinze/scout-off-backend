import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";

import {
  registerPlayer,
  getPlayer,
  filterPlayers,
  getPlayerMilestones,
  updatePlayer,
  getPlayerAnalytics,
  registerSchema,
  filterSchema,
  updatePlayerSchema,
} from "../controllers/playerController";
import { getPlayerHistory } from "../controllers/playerHistoryController";
import { acceptTrialOffer, rejectTrialOffer, rejectOfferSchema } from "../controllers/trialOfferController";

import { validateBody, validateQuery } from "../middleware/validate";
import { requireRole, optionalAuth } from "../middleware/auth";
import { requireOwner } from "../middleware/requireOwner";
import { methodNotAllowed } from "../middleware/methodNotAllowed";

const router = Router();

/**
 * GET /api/players
 * optionalAuth so req.account is set when a Bearer token is present (for audit logging)
 */
router.route("/")
  .get(optionalAuth, validateQuery(filterSchema), filterPlayers)
  .all(methodNotAllowed(['GET', 'HEAD']));

router.route("/register")
  .post(
    requireRole("player"),
    validateBody(registerSchema, { context: "player_registration" }),
    registerPlayer,
  )
  .all(methodNotAllowed(['POST']));

router.route("/:playerId")
  .get(getPlayer)
  .put(
    requireRole("player"),
    requireOwner,
    validateBody(updatePlayerSchema),
    updatePlayer,
  )
  .all(methodNotAllowed(['GET', 'PUT', 'HEAD']));

router.route("/:playerId/milestones")
  .get(getPlayerMilestones)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/players/:playerId/history
 * Admin or profile owner only.
 */
router.route("/:playerId/history")
  .get(
    optionalAuth,
    (req: Request, res: Response, next: NextFunction) => {
      if (req.role === "admin") {
        return getPlayerHistory(req, res, next);
      }
      return requireRole("player")(req, res, () => requireOwner(req, res, next));
    },
  )
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * GET /api/players/:playerId/analytics
 * Return profile view and contact unlock analytics (owner-only).
 */
router.route("/:playerId/analytics")
  .get(
    requireRole("player"),
    requireOwner,
    getPlayerAnalytics,
  )
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/players/:playerId/trial-offers/:offerId/accept
 *
 * Accept a trial offer. Only the player who owns this playerId may respond.
 *
 * @param playerId {string} - The player's on-chain identifier
 * @param offerId  {string} - The trial offer identifier
 * @response 200 { success: true, data: { offerId, playerId, status: 'accepted', respondedAt } }
 * @response 403 { success: false, error: string } - Not the offer's target player
 * @response 404 { success: false, error: string } - Offer not found
 * @response 409 { success: false, error: string } - Offer already responded to
 * @auth Bearer (player role required)
 */
router.route("/:playerId/trial-offers/:offerId/accept")
  .post(requireRole("player"), acceptTrialOffer)
  .all(methodNotAllowed(['POST']));

/**
 * POST /api/players/:playerId/trial-offers/:offerId/reject
 *
 * Reject a trial offer with an optional reason. Only the player who owns this playerId may respond.
 *
 * @param playerId {string} - The player's on-chain identifier
 * @param offerId  {string} - The trial offer identifier
 * @body { reason?: string } - Optional rejection reason (max 500 chars)
 * @response 200 { success: true, data: { offerId, playerId, status: 'rejected', reason, respondedAt } }
 * @response 403 { success: false, error: string } - Not the offer's target player
 * @response 404 { success: false, error: string } - Offer not found
 * @response 409 { success: false, error: string } - Offer already responded to
 * @auth Bearer (player role required)
 */
router.route("/:playerId/trial-offers/:offerId/reject")
  .post(
    requireRole("player"),
    validateBody(rejectOfferSchema),
    rejectTrialOffer,
  )
  .all(methodNotAllowed(['POST']));

export default router;
