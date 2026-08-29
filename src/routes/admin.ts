import { Router } from 'express';
import { getStats, getAllEvents, getFeeSummary, registerValidator, revokeValidator, pauseContract, unpauseContract, withdrawFeesController, introspectToken, reindex, getValidatorStatsEndpoint, getAuditLog, getWebhookDeliveriesEndpoint, getWebhookDeliverySummaryEndpoint } from '../controllers/adminController';
import { exportEvents } from '../controllers/exportController';
import { requireRole } from '../middleware/auth';

const router = Router();

/**
 * GET /api/admin/stats
 *
 * Returns aggregate platform counts: players, milestones, subscriptions, and total events.
 *
 * @response 200 { success: true, data: { players, milestones, subscriptions, events } }
 * @auth Bearer (admin role required)
 */
router.get('/stats', requireRole('admin'), getStats);

/**
 * GET /api/admin/events
 *
 * Returns all indexed Soroban contract events in insertion order.
 * Query params: startDate, endDate (ISO 8601), eventType
 *
 * @response 200 { success: true, data: AdminEvent[] }
 * @response 400 { success: false, error: string } - Invalid date range
 * @auth Bearer (any authenticated user)
 */
router.get('/events', requireRole('admin'), getAllEvents);

/**
 * GET /api/admin/events/export
 *
 * Exports all indexed Soroban contract events as CSV format.
 * Useful for data analysis, reporting, and external system integration.
 *
 * @response 200 CSV file with columns: event_type, ledger, timestamp, payload
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.get('/events/export', requireRole('admin'), exportEvents);

/**
 * GET /api/admin/fees
 *
 * Returns a list of fee withdrawal events from the contract.
 * Query params: startDate, endDate (ISO 8601)
 *
 * @response 200 { success: true, data: FeeHistoryItem[] }
 * @auth Bearer (admin role required)
 */
router.get('/fees', requireRole('admin'), getFeeSummary);

/**
 * GET /api/admin/audit
 *
 * Returns paginated audit log entries. Supports `startDate`, `endDate` (ISO 8601),
 * `action` filters, and `limit`/`offset` pagination.
 *
 * @response 200 { success: true, data: AuditLogRow[], total, limit, offset }
 * @auth Bearer (admin role required)
 */
router.get('/audit', requireRole('admin'), getAuditLog);

/**
 * POST /api/admin/fees
 *
 * Withdraws accumulated platform fees from the Soroban contract to a specified recipient.
 *
 * @body recipient {string} - Stellar public key of the withdrawal recipient
 * @response 200 { success: true, data: { transactionId, recipient, amount, token } }
 * @response 400 { success: false, error: string } - Invalid recipient address
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @response 409 { success: false, error: string } - No fees available
 * @auth Bearer (admin role required)
 */
router.post('/fees', requireRole('admin'), withdrawFeesController);

/**
 * POST /api/admin/validators/register
 *
 * Submits a request to register a new validator on the Soroban contract.
 * Only platform admins may call this endpoint.
 *
 * @body validatorWallet {string} - Stellar public key of the validator to register
 * @response 202 { success: true, message: string }
 * @response 400 { success: false, error: string } - Invalid Stellar address
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.post('/validators/register', requireRole('admin'), registerValidator);

/**
 * POST /api/admin/validators/revoke
 *
 * Submits a request to revoke an existing validator on the Soroban contract.
 * Only platform admins may call this endpoint.
 *
 * @body validatorWallet {string} - Stellar public key of the validator to revoke
 * @response 202 { success: true, message: string }
 * @response 400 { success: false, error: string } - Invalid Stellar address
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.post('/validators/revoke', requireRole('admin'), revokeValidator);

/**
 * POST /api/admin/contract/pause
 *
 * Stub endpoint that simulates pausing the Soroban smart contract.
 * Contract-level behavior is simulated — no real on-chain transaction is issued.
 *
 * @response 202 { success: true, message: string, transactionId: string }
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.post('/contract/pause', requireRole('admin'), pauseContract);

/**
 * POST /api/admin/contract/unpause
 *
 * Stub endpoint that simulates unpausing the Soroban smart contract.
 * Contract-level behavior is simulated — no real on-chain transaction is issued.
 *
 * @response 202 { success: true, message: string, transactionId: string }
 * @response 401 { success: false, error: string } - Missing token
 * @response 403 { success: false, error: string } - Non-admin role
 * @auth Bearer (admin role required)
 */
router.post('/contract/unpause', requireRole('admin'), unpauseContract);

/**
 * POST /api/admin/introspect
 *
 * Validates a JWT and returns its payload metadata without exposing secrets.
 * Useful for admins to inspect token claims (subject, role, expiry).
 *
 * @body token {string} - JWT to introspect
 * @response 200 { success: true, data: { sub, role, iat, exp } }
 * @response 400 { success: false, error: string } - Missing token or invalid/expired JWT
 * @auth Bearer (admin role required)
 */
router.post('/introspect', requireRole('admin'), introspectToken);

/**
 * POST /api/admin/indexer/reindex
 *
 * Resets the indexer's stored last_ledger to the given fromLedger value,
 * causing the next poll cycle to replay all events from that ledger onward.
 *
 * @body fromLedger {number} - Ledger sequence number to replay from
 * @response 200 { success: true, data: { fromLedger, previous } }
 * @response 400 { success: false, error: string } - Invalid fromLedger
 * @auth Bearer (admin role required)
 */
router.post('/indexer/reindex', requireRole('admin'), reindex);

router.get('/validators/:wallet/stats', requireRole('admin'), getValidatorStatsEndpoint);

/**
 * GET /api/admin/webhooks/:id/deliveries
 *
 * Returns paginated delivery-attempt records (success + failure) for a webhook
 * subscription. `:id` should be the URL-encoded subscription identifier
 * (typically the endpoint URL).
 *
 * @query limit  - Page size 1–100 (default 20)
 * @query offset - Row offset (default 0)
 * @response 200 { success: true, data: WebhookDeliveryRow[], total, limit, offset }
 * @auth Bearer (admin role required)
 */
router.get('/webhooks/:id/deliveries', requireRole('admin'), getWebhookDeliveriesEndpoint);

/**
 * GET /api/admin/webhooks/:id/summary
 *
 * Returns a rolled-up success-rate summary (total, successes, failures,
 * success_rate, last_success_at) for a subscription over a configurable window.
 *
 * @query windowMs - Window in milliseconds (default 86400000 = 24 h)
 * @response 200 { success: true, data: WebhookDeliverySummary }
 * @auth Bearer (admin role required)
 */
router.get('/webhooks/:id/summary', requireRole('admin'), getWebhookDeliverySummaryEndpoint);

export default router;
