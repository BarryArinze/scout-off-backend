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
  registerSchema,
  filterSchema,
  updatePlayerSchema,
  deactivatePlayerEndpoint,
  reactivatePlayerEndpoint,
} from "../controllers/playerController";
import { getPlayerHistory } from "../controllers/playerHistoryController";
import { acceptTrialOffer, rejectTrialOffer, rejectOfferSchema } from "../controllers/trialOfferController";
import { getPlayerTokenHolders, buyPlayerToken } from "../controllers/playerTokenController";

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
  .get(optionalAuth, getPlayer)
  .put(
    requireRole("player"),
    requireOwner,
    validateBody(updatePlayerSchema),
    updatePlayer,
  )
  .all(methodNotAllowed(['GET', 'PUT', 'HEAD']));

router.route("/:playerId/milestones")
  .get(optionalAuth, getPlayerMilestones)
  .all(methodNotAllowed(['GET', 'HEAD']));

router.route("/:playerId/deactivate")
  .post(
    requireRole("player"),
    requireOwner,
    deactivatePlayerEndpoint,
  )
  .all(methodNotAllowed(['POST']));

router.route("/:playerId/reactivate")
  .post(
    requireRole("player"),
    requireOwner,
    reactivatePlayerEndpoint,
  )
  .all(methodNotAllowed(['POST']));

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

/**
 * GET /api/players/:playerId/tokens
 *
 * Return the list of token holders and their balances for the given player.
 * Gated by the `player_tokens` feature flag — returns 404 when disabled.
 *
 * @param playerId {string} - The player's on-chain identifier
 * @response 200 { success: true, data: { playerId, holders: [{ holder, tokens }], meta } }
 * @response 404 { success: false, error: string } - Feature flag disabled
 * @auth Bearer (optional — public read)
 */
router.route("/:playerId/tokens")
  .get(optionalAuth, getPlayerTokenHolders)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/players/:playerId/tokens/buy
 *
 * Purchase Player Tokens for the given player (stub — no real XLM transfer).
 * Gated by the `player_tokens` feature flag — returns 404 when disabled.
 *
 * @param playerId {string} - The player's on-chain identifier
 * @body { amount: number, buyerWallet: string }
 * @response 200 { success: true, data: { playerId, buyerWallet, amount, newBalance } }
 * @response 400 { success: false, error: string } - Invalid amount
 * @response 404 { success: false, error: string } - Feature flag disabled or player not found
 * @auth Bearer (scout or player role required)
 */
router.route("/:playerId/tokens/buy")
  .post(requireRole("scout"), buyPlayerToken)
  .all(methodNotAllowed(['POST']));

export default router;
