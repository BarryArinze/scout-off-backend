import { Router } from 'express';
import {
  getSubscription,
  getUnlockedContacts,
  getContactDetails,
  unlockContact,
  getPaymentHistory,
  subscribe,
  renewSubscription,
  cancelSubscription,
  submitTrialOffer,
  listTrialOffers,
  createTrialOffer,
  trialOfferSchema,
  unlockContactSchema,
} from '../controllers/scoutController';
import { getScoutRecommendations } from '../controllers/scoutRecommendationsController';
import {
  putScoutNote,
  getScoutNoteHandler,
  listScoutNotesHandler,
  createPlayerNote,
  listPlayerNotes,
  updatePlayerNote,
  deletePlayerNote,
} from '../controllers/scoutNotesController';
import { issueApiKey, listApiKeys, revokeApiKey } from '../controllers/apiKeyController';
import {
  addBookmark,
  removeBookmark,
  listBookmarks,
  createBookmarkFolder,
  listBookmarkFolders,
  deleteBookmarkFolderHandler,
} from '../controllers/scoutBookmarksController';
import { createSavedSearch, listSavedSearches, deleteSavedSearchHandler, updateSavedSearchHandler, runSavedSearch } from '../controllers/scoutSavedSearchesController';
import {
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  testWebhook,
} from '../controllers/webhookSubscriptionController';
import { requireFeatureFlag } from '../middleware/requireFeatureFlag';
import { FeatureFlags } from '../services/featureFlags';
import { requireRole } from '../middleware/auth';
import { idempotency } from '../middleware/idempotency';
import { validateBody } from '../middleware/validate';
import { walletRateLimit } from '../middleware/rateLimit';
import { methodNotAllowed } from '../middleware/methodNotAllowed';

const router = Router();

/**
 * GET /api/scouts/:wallet/subscription
 *
 * Returns the active subscription status for a scout wallet.
 * Response includes a `gracePeriodActive` boolean field.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: { active, tier, expiresAt, remainingDays, gracePeriodActive } }
 * @response 401 { success: false, error: string } - Missing or invalid token
 * @auth Bearer (scout role required)
 */
router.route('/:wallet/subscription')
  .get(requireRole('scout'), getSubscription)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/scouts/:wallet/subscribe
 *
 * Purchase a new scout subscription.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @body { tier: 'basic' | 'premium', duration: number (1–365 days) }
 * @header Idempotency-Key {string} - Optional. Ensures safe retries: duplicate keys return
 *   the cached response for 24 hours without triggering a new on-chain transaction.
 * @response 201 { success: true, data: { transactionId, tier, expiresAt, status } }
 * @response 400 { success: false, error: string } - Invalid tier or duration
 * @response 402 { success: false, error: string } - Insufficient XLM balance
 * @response 403 { success: false, error: string } - Scout role required or wallet mismatch
 * @auth Bearer (scout role required)
 *
 * PUT /api/scouts/:wallet/subscribe
 *
 * Renew or create a subscription.
 * If an existing subscription exists, extends its expiry by `duration` days.
 * If no subscription exists, behaves like POST (creates a new one).
 *
 * @param wallet {string} - Scout's Stellar public key
 * @body { tier: 'basic' | 'premium', duration: number (1–365 days) }
 * @response 200 { success: true, data: { transactionId, tier, expiresAt, status } } - Renewal
 * @response 201 { success: true, data: { transactionId, tier, expiresAt, status } } - New subscription
 * @response 400 { success: false, error: string } - Invalid tier or duration
 * @response 402 { success: false, error: string } - Insufficient XLM balance
 * @response 403 { success: false, error: string } - Scout role required or wallet mismatch
 * @auth Bearer (scout role required)
 *
 * DELETE /api/scouts/:wallet/subscribe
 *
 * Cancel an active subscription. Records cancellation on-chain and locally.
 *
 * @param wallet {string} - Scout's Stellar public key
 * @response 200 { success: true, data: { transactionId, cancelledAt, wallet } }
 * @response 403 { success: false, error: string } - Scout role required or wallet mismatch
 * @response 404 { success: false, error: string } - No active subscription found
 * @auth Bearer (scout role required)
 */
router.route('/:wallet/subscribe')
  .post(requireRole('scout'), walletRateLimit(), idempotency, subscribe)
  .put(requireRole('scout'), walletRateLimit(), renewSubscription)
  .delete(requireRole('scout'), cancelSubscription)
  .all(methodNotAllowed(['POST', 'PUT', 'DELETE']));

/**
 * GET /api/scouts/:wallet/contacts
 *
 * GET /api/scouts/:wallet/contacts/:playerId
 */
router.route('/:wallet/contacts')
  .get(requireRole('scout'), getUnlockedContacts)
  .all(methodNotAllowed(['GET', 'HEAD']));

router.route('/:wallet/contacts/:playerId')
  .get(requireRole('scout'), getContactDetails)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/scouts/:wallet/contacts/:playerId/unlock
 */
router.route("/:wallet/contacts/:playerId/unlock")
  .post(
    requireRole("scout"),
    walletRateLimit(),
    validateBody(unlockContactSchema),
    unlockContact,
  )
  .all(methodNotAllowed(['POST']));

router.route('/:wallet/payments')
  .get(requireRole('scout'), getPaymentHistory)
  .all(methodNotAllowed(['GET', 'HEAD']));

/**
 * POST /api/scouts/:wallet/trial-offer
 */
router.route('/:wallet/trial-offer')
  .post(
    requireRole('scout'),
    validateBody(trialOfferSchema),
    submitTrialOffer,
  )
  .all(methodNotAllowed(['POST']));

/**
 * GET /api/scouts/:wallet/trial-offers
 * POST /api/scouts/:wallet/trial-offers
 *
 * On-chain trial offer event log (#285): submits (and lists) trial offers
 * indexed locally by tx_hash. Distinct from the singular /trial-offer stub
 * endpoint above and from the accept/reject workflow in trialOfferController.
 */
router.route('/:wallet/trial-offers')
  .get(requireRole('scout'), listTrialOffers)
  .post(
    requireRole('scout'),
    walletRateLimit(),
    idempotency,
    validateBody(trialOfferSchema),
    createTrialOffer,
  )
  .all(methodNotAllowed(['GET', 'POST', 'HEAD']));

/**
 * GET /api/scouts/:wallet/recommendations
 */
router.route('/:wallet/recommendations')
  .get(
    requireRole('scout'),
    getScoutRecommendations,
  )
  .all(methodNotAllowed(['GET', 'HEAD']));

// ─── Private scout notes (#488) ───────────────────────────────────────────────

/**
 * PUT /api/scouts/:wallet/notes/:playerId
 * Create or update (upsert) a private note on a player profile.
 * Only the authoring scout can read or write their notes.
 *
 * GET /api/scouts/:wallet/notes/:playerId
 * Retrieve the authenticated scout's note for a specific player.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/notes/:playerId')
  .put(requireRole('scout'), putScoutNote)
  .get(requireRole('scout'), getScoutNoteHandler)
  .all(methodNotAllowed(['PUT', 'GET', 'HEAD']));

/**
 * GET /api/scouts/:wallet/notes
 * List all private notes for the authenticated scout, ordered newest-first.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/notes')
  .get(requireRole('scout'), listScoutNotesHandler)
  .all(methodNotAllowed(['GET', 'HEAD']));

// ─── Multi-note CRUD for scout-player notes ───────────────────────────────────

/**
 * POST /api/scouts/:wallet/players/:playerId/notes
 * Create a new private note for the authenticated scout on the given player.
 * Body: { content: string } — max 2 000 characters.
 *
 * GET /api/scouts/:wallet/players/:playerId/notes
 * List all private notes for the scout-player pair, newest-first.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/players/:playerId/notes')
  .post(requireRole('scout'), createPlayerNote)
  .get(requireRole('scout'), listPlayerNotes)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * PUT /api/scouts/:wallet/players/:playerId/notes/:noteId
 * Update a note's content.  Returns 404 when not found.
 *
 * DELETE /api/scouts/:wallet/players/:playerId/notes/:noteId
 * Delete a note.  Returns 404 when not found.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/players/:playerId/notes/:noteId')
  .put(requireRole('scout'), updatePlayerNote)
  .delete(requireRole('scout'), deletePlayerNote)
  .all(methodNotAllowed(['PUT', 'DELETE']));

// ─── API key management (#490) ────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/api-keys
 * Issue a new API key for server-to-server integrations. Returns the plaintext
 * key exactly once; only a salted hash is persisted.
 *
 * GET /api/scouts/:wallet/api-keys
 * List existing API keys (metadata + hash prefix only — no plaintext).
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/api-keys')
  .post(requireRole('scout'), issueApiKey)
  .get(requireRole('scout'), listApiKeys)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * DELETE /api/scouts/:wallet/api-keys/:id
 * Revoke an existing API key by its row id.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/api-keys/:id')
  .delete(requireRole('scout'), revokeApiKey)
  .all(methodNotAllowed(['DELETE']));

// ─── Scout bookmarks (#487) ───────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/bookmarks
 * Bookmark a player with optional folder and note. Idempotent — no error if already bookmarked.
 * Body: { playerId: string, folderId?: number, note?: string }
 * Returns 404 when the player does not exist.
 *
 * GET /api/scouts/:wallet/bookmarks
 * List all bookmarked players with full profile summaries.
 * Supports ?folderId= query parameter to filter by folder.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/bookmarks')
  .post(requireRole('scout'), addBookmark)
  .get(requireRole('scout'), listBookmarks)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * DELETE /api/scouts/:wallet/bookmarks/:playerId
 * Remove a bookmark. Returns 404 when the bookmark does not exist.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/bookmarks/:playerId')
  .delete(requireRole('scout'), removeBookmark)
  .all(methodNotAllowed(['DELETE']));

/**
 * POST /api/scouts/:wallet/bookmark-folders
 * Create a new bookmark folder. Body: { name: string }
 *
 * GET /api/scouts/:wallet/bookmark-folders
 * List all bookmark folders with bookmark counts.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/bookmark-folders')
  .post(requireRole('scout'), createBookmarkFolder)
  .get(requireRole('scout'), listBookmarkFolders)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * DELETE /api/scouts/:wallet/bookmark-folders/:folderId
 * Delete a bookmark folder. Bookmarks move to root (not deleted).
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/bookmark-folders/:folderId')
  .delete(requireRole('scout'), deleteBookmarkFolderHandler)
  .all(methodNotAllowed(['DELETE']));

// ─── Scout saved searches (#486) ──────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/saved-searches
 * Create a new named saved search.  The filter payload is validated against
 * the same Zod schema used by the live player-filter endpoint.
 *
 * GET /api/scouts/:wallet/saved-searches
 * List all saved searches for the authenticated scout, newest-first.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/saved-searches')
  .post(requireRole('scout'), requireFeatureFlag(FeatureFlags.SAVED_SEARCHES), createSavedSearch)
  .get(requireRole('scout'), requireFeatureFlag(FeatureFlags.SAVED_SEARCHES), listSavedSearches)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * DELETE /api/scouts/:wallet/saved-searches/:id
 * Delete a saved search by its row id.
 * A scout cannot delete another scout's saved searches.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/saved-searches/:id')
  .put(requireRole('scout'), requireFeatureFlag(FeatureFlags.SAVED_SEARCHES), updateSavedSearchHandler)
  .delete(requireRole('scout'), requireFeatureFlag(FeatureFlags.SAVED_SEARCHES), deleteSavedSearchHandler)
  .all(methodNotAllowed(['PUT', 'DELETE']));

/**
 * GET /api/scouts/:wallet/saved-searches/:id/run
 * Execute a saved search and return matching players (paginated).
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/saved-searches/:id/run')
  .get(requireRole('scout'), requireFeatureFlag(FeatureFlags.SAVED_SEARCHES), runSavedSearch)
  .all(methodNotAllowed(['GET', 'HEAD']));

// ─── Webhook subscription management (#806) ───────────────────────────────────

/**
 * POST /api/scouts/:wallet/webhooks
 * Register a webhook URL. Generates a per-subscription HMAC secret returned
 * once in plaintext; subsequent GETs show a masked value only.
 * Body: { url: string, eventTypes?: ContractEventType[] }
 *
 * GET /api/scouts/:wallet/webhooks
 * List all active subscriptions (secrets masked).
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/webhooks')
  .post(requireRole('scout'), registerWebhook)
  .get(requireRole('scout'), listWebhooks)
  .all(methodNotAllowed(['POST', 'GET', 'HEAD']));

/**
 * DELETE /api/scouts/:wallet/webhooks/:id
 * Delete a subscription. Returns 404 when not found or owned by another scout.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/webhooks/:id')
  .delete(requireRole('scout'), deleteWebhook)
  .all(methodNotAllowed(['DELETE']));

/**
 * POST /api/scouts/:wallet/webhooks/:id/test
 * Send a test ping to the registered URL, signed with the subscription secret.
 * Returns 502 when the remote server does not respond with 2xx.
 *
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
router.route('/:wallet/webhooks/:id/test')
  .post(requireRole('scout'), testWebhook)
  .all(methodNotAllowed(['POST']));

export default router;
