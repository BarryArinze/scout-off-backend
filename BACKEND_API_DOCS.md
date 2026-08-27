# ScoutOff Backend API Documentation

All endpoints are served from the base URL configured via `PORT` (default: `4000`).

---

## Table of Contents

- [API Versioning](#api-versioning)
- [Authentication](#authentication)
- [Endpoints](#endpoints) — generated OpenAPI spec, see [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md)
- [Saved Search Run Endpoint](#saved-search-run-endpoint-get-apiscoutswalletsaved-searchesidrun)
- [Stubbed Routes](#stubbed-routes)
- [Error Format](#error-format)

---

## API Versioning

The platform supports two stable API versions. All routes are available under multiple prefixes:

| Prefix     | Description                                  |
| ---------- | -------------------------------------------- |
| `/api`     | Unversioned alias (maps to v1; **deprecated** in production) |
| `/api/v1`  | Stable v1 — use this for all new integrations |
| `/api/v2`  | Stable v2 — currently identical to v1; new v2-only behaviour will be introduced here |

### Selecting a version

**URL prefix (recommended)**

```bash
# v1
curl http://localhost:4000/api/v1/players

# v2
curl http://localhost:4000/api/v2/players
```

**`API-Version` request header (alternative)**

Send `API-Version: 2` on any unversioned `/api/` path to be routed to v2 handlers:

```bash
curl -H "API-Version: 2" http://localhost:4000/api/players
```

### `API-Version` response header

Every response from an `/api/` path includes an `API-Version` response header indicating which version actually handled the request:

```
API-Version: 1
```

or

```
API-Version: 2
```

### Deprecation policy

Calling the bare `/api/` prefix (without `/v1` or `/v2`) in a **production** environment emits a `warn`-level log entry:

```
[deprecation] Unversioned /api/ path called: GET /api/players — prefer /api/v1/ or /api/v2/. Unversioned paths will be removed in a future release.
```

Clients should migrate to `/api/v1/` to suppress this warning and prepare for the eventual removal of the unversioned alias.

---

## Authentication

Most protected routes require a **Bearer JWT** obtained from `POST /auth/token`.

```
Authorization: Bearer <token>
```

Tokens are issued after a successful SEP-10 Stellar wallet challenge/response flow.

### API keys & scopes (#1019)

Server-to-server integrations can authenticate with a long-lived API key
instead of a JWT:

```
X-API-Key: <raw-key>
```

API keys are issued via `POST /api/scouts/:wallet/api-keys` and revoked via
`DELETE /api/scouts/:wallet/api-keys/:id`. Only a salted hash is stored.

#### Scope enforcement

Keys without an explicit `scopes` list (legacy keys) keep **unrestricted**
scout-level access — backward compatible with keys issued before scope
enforcement. Keys issued with an explicit `scopes` list are **restricted**:
mutating endpoints require the matching scope and return `403` with
`reason.requiredScope` otherwise.

| Scope | Enforced on |
|-------|-------------|
| `write:contacts` | `POST /scouts/:wallet/contacts/:playerId/unlock` |
| `write:subscriptions` | `POST/PUT/DELETE /scouts/:wallet/subscribe` |
| `write:trial_offers` | `POST /scouts/:wallet/trial-offers` (and its deprecated alias `/trial-offer`); `DELETE /scouts/:wallet/trial-offers/:offerId` |
| `write:webhooks` | `POST /scouts/:wallet/webhooks`, `DELETE .../:id`, `POST .../:id/test` |
| `write:api_keys` | `POST /scouts/:wallet/api-keys`, `DELETE .../:id` |
| `write:bookmarks` | bookmark & bookmark-folder mutations |
| `write:notes` | scout-note mutations |
| `write:saved_searches` | saved-search mutations |
| `write:player_tokens` | `POST /players/:playerId/tokens/buy` |
| `read:subscription` | `GET /scouts/:wallet/subscription` |

REST and GraphQL share the same scope contract (`src/utils/apiKeyScopes.ts`).
See `docs/auth.md` for the full vocabulary and legacy-compatibility rules.

---

## Endpoints

This section used to be a hand-maintained, per-endpoint reference. It drifted from the real API surface — several endpoint groups documented here were missing entirely (see #1047) — because nothing kept it in sync with the route source files, and every new endpoint required a second, easy-to-forget manual update.

That table has been replaced by a **generated OpenAPI 3.0 spec** that is produced mechanically from the route source itself (`src/routes/*.ts`) by `scripts/generate-openapi-json.js`, and validated in CI against that same source (`npm run validate:openapi`) so it cannot drift again. See [docs/API_DOCUMENTATION.md](docs/API_DOCUMENTATION.md) for how the generator works and how to keep it accurate when you add or change a route.

**Browse the full, current endpoint reference:**

| Surface | URL |
| --- | --- |
| Swagger UI (interactive) | `GET /api/docs/ui` |
| OpenAPI spec (JSON) | `GET /api/docs` |
| OpenAPI spec (YAML) | `GET /api/docs/yaml` |
| Source of truth (in-repo) | [src/openapi.yaml](src/openapi.yaml) |

Regenerate it locally after changing a route:

```bash
npm run build:openapi     # regenerate src/openapi.yaml + src/openapi.json
npm run validate:openapi  # confirm the committed spec matches the routes
npm run docs:check        # confirm every route has a documented summary + responses
```

---

### Admin Multi-Signature Actions

High-value admin operations require M-of-N approval when `ADMIN_THRESHOLD > 1`. The multi-signature system provides atomic execution and tamper-proof audit trails for critical platform operations.

#### Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ADMIN_THRESHOLD` | Minimum signatures required | `1` |
| `ADMIN_WALLETS` | Comma-separated list of authorized admin wallets | Required |

`pending_admin_actions` and `admin_action_signatures` (the tables backing this subsystem) work under both `DB_DRIVER=sqlite` and `DB_DRIVER=postgres` — the two migrations (`db/011_pending_admin_actions.sql` / `db/011_pending_admin_actions_postgres.sql`) declare equivalent columns, including `proposer` and the signer-uniqueness table. Duplicate-signature detection uses `INSERT OR IGNORE` on SQLite and `INSERT ... ON CONFLICT(action_id, signer) DO NOTHING` on Postgres, both driven by a single atomic statement rather than a racy check-then-insert.

#### Action Types

The following admin operations support multi-signature approval:

- `pause_contract` — Emergency pause of platform contracts
- `unpause_contract` — Resume platform operations  
- `withdraw_fees` — Withdraw accumulated platform fees
- `register_validator` — Add new validator to authorized list
- `revoke_validator` — Remove validator from authorized list
- `bulk_validator_import` — Import multiple validators (individual actions per validator)
- `update_platform_fee` — Modify platform fee structure *(future)*

#### Multi-Signature Flow

1. **Propose Action**: First admin calls the operation endpoint (e.g., `POST /api/admin/validators/register`)
2. **Collect Signatures**: Additional admins approve via `POST /api/admin/actions/{id}/approve`
3. **Automatic Execution**: When threshold is reached, the real operation executes automatically — the same on-chain call the single-admin (`ADMIN_THRESHOLD = 1`) immediate path uses, so behavior is identical between threshold=1 and threshold>1 deployments
4. **Audit Trail**: All steps are logged with tamper-proof audit records

Every `action_type` maps to exactly one execution handler (`pause_contract` → `pauseContractOnChain`, `unpause_contract` → `unpauseContractOnChain`, `withdraw_fees` → `withdrawFees`, `register_validator` / `bulk_validator_import` → `registerValidatorOnChain`, `revoke_validator` → `revokeValidatorOnChain`); the dispatcher routes purely on `action_type`, never on payload contents. `withdraw_fees` is proposed from two call sites with different payload shapes — the legacy `POST /api/admin/fees` endpoint sends `{ recipient }`, the fully-specified `POST /api/admin/fees/withdraw` (v2) endpoint sends `{ treasuryAddress, amountStroops }` — the dispatcher accepts either.

#### `GET /api/admin/actions/pending`

List all pending multi-signature actions (expired ones are purged on read). **Requires Bearer auth (admin role).**

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": "cm123456789",
      "actionType": "register_validator",
      "proposer": "GADMIN1...",
      "payload": { "validatorWallet": "GVALIDATOR..." },
      "collectedSignatures": 1,
      "requiredSignatures": 2,
      "expiresAt": 1735689600000,
      "createdAt": 1735603200000
    }
  ]
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/admin/actions/pending" \
  -H "Authorization: Bearer <admin-jwt>"
```

---

#### `GET /api/admin/actions/{id}`

Get detailed information about a specific action, including all signers collected so far. **Requires Bearer auth (admin role).**

**Response `200`**

```json
{
  "success": true,
  "data": {
    "id": "cm123456789",
    "actionType": "register_validator",
    "proposer": "GADMIN1...",
    "payload": { "validatorWallet": "GVALIDATOR..." },
    "status": "pending",
    "collectedSignatures": 1,
    "requiredSignatures": 2,
    "expiresAt": 1735689600000,
    "createdAt": 1735603200000,
    "signers": [
      { "wallet": "GADMIN1...", "signedAt": 1735603200000 }
    ]
  }
}
```

**Response `404`** — action not found

**Example request**

```bash
curl -X GET "http://localhost:4000/api/admin/actions/cm123456789" \
  -H "Authorization: Bearer <admin-jwt>"
```

---

#### `POST /api/admin/actions/{id}/approve`

Approve a pending multi-signature action. When the signature threshold is reached, the underlying operation executes automatically. **Requires Bearer auth (admin role).**

**Response `202`** — signature recorded, more approvals needed

```json
{
  "success": true,
  "message": "Signature recorded, 1 more signature(s) needed",
  "data": {
    "actionId": "cm123456789",
    "collectedSignatures": 1,
    "requiredSignatures": 2,
    "status": "pending"
  }
}
```

**Response `200`** — threshold reached, action executed

```json
{
  "success": true,
  "message": "Approval threshold reached — action executed",
  "data": {
    "actionId": "cm123456789",
    "collectedSignatures": 2,
    "requiredSignatures": 2,
    "status": "executed"
  }
}
```

**Response `409`** — duplicate signature (same admin signing the same still-pending action twice)

```json
{
  "success": false,
  "error": "Admin has already signed this action",
  "code": "CONFLICT"
}
```

**Response `409`** — action already executed (approving an action a second time after it already reached quorum)

```json
{
  "success": false,
  "error": "Action has already been executed",
  "code": "ACTION_EXECUTED"
}
```

**Response `404`** — action not found

**Response `410`** — action expired

**Response `500`** — execution failed (action reverts to `pending` and remains retryable — see below)

**Example request**

```bash
curl -X POST "http://localhost:4000/api/admin/actions/cm123456789/approve" \
  -H "Authorization: Bearer <admin-jwt>"
```

#### Error Handling and Recovery

- **Execution Failures**: If the underlying operation fails (network error, contract rejection), the action remains in `pending` status and can be retried by approving again
- **Expiry**: Actions expire after 24 hours (configurable via `ADMIN_ACTION_TTL_MS`)
- **Atomicity**: Signature collection is atomic — concurrent approvals from the same admin are handled gracefully
- **Idempotency**: Duplicate approvals return `409 Conflict` without affecting signature count

#### Single-Admin Mode

When `ADMIN_THRESHOLD = 1`, operations execute immediately without creating pending actions. The response format and audit logging remain consistent.

---

## Server-Sent Events (`GET /api/events/stream`) (#1019)

Long-lived SSE stream of contract events relevant to the authenticated wallet.
Authentication: Bearer JWT (any role) or `X-API-Key`. Optional query params:
`eventType` (one type) and `playerId` (narrowing). Wallet isolation is always
enforced; a `: ping` keep-alive comment is sent every
`SSE_KEEPALIVE_INTERVAL_MS` (default 15 s).

**Live authorization enforcement:**

- Revoking the connection's JWT (logout / admin revocation) emits a terminal
  `event: session_ended` (reason `token_revoked`) and closes the stream.
- Blocklisting the wallet (see `docs/auth.md`) emits `session_ended` (reason
  `wallet_blocklisted`) and closes it; blocklisted wallets also get `403` on
  new connections.
- No protected events are delivered after termination.

**Detection bound:** immediate for revocations/blocklists in the same process;
≤ `SSE_AUTH_SWEEP_INTERVAL_MS` (default 30 s) for changes persisted by
another instance (one sweep query per process — never per keep-alive tick).

## GraphQL (`POST /graphql`) (#1019)

Read-only GraphQL endpoint sharing the REST authorization model:

- **API keys:** `X-API-Key` is accepted; restricted keys enforce
  `read:milestones` (milestones queries) and `read:subscription`
  (`scoutSubscription`).
- **Milestones:** deactivated players follow the same owner/admin-only
  decision as REST (`src/utils/playerAccess.ts`); unauthorized callers get a
  `NOT_FOUND` error (root) or no data (nested `Player.milestones`).
- **Abuse control:** depth limit (`MAX_DEPTH = 5`) plus a query-cost limit
  (`MAX_QUERY_COST = 135`) that counts every field node — aliases included —
  so a single request with ~20+ aliased expensive operations is rejected
  with a `QUERY_COST_EXCEEDED` error instead of bypassing the depth limit.

## Saved Search Run Endpoint (`GET /api/scouts/:wallet/saved-searches/:id/run`)

Executes a stored saved-search preset against the live player index, returning paginated player results in the same shape as `GET /api/players`. This closes the gap between storing a filter preset and actually using it — scouts no longer need to manually copy filter parameters from the list endpoint into a separate player-search request.

**Authentication:** Bearer JWT (scout role required; wallet must match the authenticated account).  
**Feature flag:** `SAVED_SEARCHES` must be enabled.

### Request

```
GET /api/scouts/:wallet/saved-searches/:id/run
```

| Parameter | In | Type | Required | Description |
|-----------|-----|------|----------|-------------|
| `wallet` | path | string | ✓ | Scout's Stellar public key |
| `id` | path | integer | ✓ | Row ID of the saved search to run |
| `page` | query | integer | — | Page number (default: `1`) |
| `pageSize` | query | integer | — | Results per page (default: `20`, max: `100`) |

The stored filter parameters (`region`, `position`, `minTier`) are loaded from the saved search row and merged with any pagination parameters supplied in the query string. Pagination params in the query string always take precedence over any pagination fields that might be present in the stored filters (which are excluded at creation time by `savedSearchFilterSchema`).

### Response `200`

```json
{
  "success": true,
  "data": {
    "players": [
      {
        "player_id": "clxyz...",
        "wallet": "GABC...",
        "position": "Forward",
        "region": "West Africa",
        "metadataUri": "ipfs://Qm...",
        "progress_level": 2,
        "created_at": 1700000000,
        "tierName": "Established",
        "tierDescription": "Performance milestones verified"
      }
    ],
    "total": 42,
    "page": 1,
    "pageSize": 20
  }
}
```

### Error responses

| Status | Condition |
|--------|-----------|
| `400` | `id` is not a valid integer |
| `403` | Wallet mismatch or not the scout role |
| `404` | Saved search not found (or belongs to another scout) |

### Example

```bash
# Create a saved search
curl -X POST "http://localhost:4000/api/scouts/${WALLET}/saved-searches" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"name":"West Africa Forwards Tier 2+","filters":{"region":"West Africa","position":"Forward","minTier":2}}'
# → { "data": { "id": 7, ... } }

# Run it (page 2, 10 results per page)
curl "http://localhost:4000/api/scouts/${WALLET}/saved-searches/7/run?page=2&pageSize=10" \
  -H "Authorization: Bearer <token>"
```

---

## Stubbed Routes

The following routes currently return data sourced entirely from indexed on-chain events and have no corresponding write/mutation endpoint in the backend:

| Route                                    | Reason                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/scouts/:wallet/subscription`   | Subscription state managed on-chain via `subscribe()`; backend is read-only   |
| `GET /api/scouts/:wallet/contacts`       | Contact unlocks managed on-chain via `pay_to_contact()`; backend is read-only |
| `GET /api/validators/milestones/pending` | Milestone approval is an on-chain transaction; backend only indexes events    |

---

## Rate Limiting

Most scout write endpoints (`subscribe`, `unlockContact`, `createTrialOffer`,
webhook registration, etc.) apply `walletRateLimit()`, which pools requests
per authenticated wallet into a shared default counter
(`RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`, default **60 s / 60 requests**,
per wallet). Exceeding it returns:

```json
{
  "success": false,
  "error": "Too many requests, please try again later"
}
```

with HTTP status **429**.

### Per-route overrides

| Route | Limit | Reason |
|-------|-------|--------|
| `POST /api/scouts/:wallet/webhooks/:id/test` | **5 requests/minute** per wallet (`WEBHOOK_TEST_RATE_LIMIT_MAX` / `WEBHOOK_TEST_RATE_LIMIT_WINDOW_MS`), isolated from the shared default pool | Unlike a normal write, each call makes the backend issue an outbound HTTP request to a caller-supplied URL — an abuse surface a shared 60/min pool doesn't adequately bound (#1037). The 429 is returned before the outbound request is attempted. |

## Request Timeouts

A global request timeout (`REQUEST_TIMEOUT_MS`, default **30 s**) is applied to all routes via the `requestTimeout` middleware in `app.ts`. When a response has not been sent within the configured window, the middleware writes:

```json
{
  "success": false,
  "error": "Request timed out",
  "code": "REQUEST_TIMEOUT"
}
```

with HTTP status **503**.

### Per-route overrides

Certain routes override the default timeout because their expected duration differs significantly:

| Route | Timeout | Reason |
|-------|---------|--------|
| `GET /api/admin/events/export` | **120 s** | Streaming CSV export of large tables can take up to 60 s; the longer window prevents a spurious 503 on a slow-but-healthy export. |
| `POST /api/admin/reindex` | **none (0)** | Returns 202 immediately — the actual ledger backfill runs as a background job and must never be killed by a network timeout. |
| `GET /health/liveness` | **5 s** | Kubernetes liveness probe — if the process cannot respond in 5 s it should be restarted. |
| `GET /health/readiness` | **5 s** | Kubernetes readiness probe — if the DB is unresponsive for more than 5 s the pod should be removed from the load-balancer. |

### Using `createTimeout` in new routes

Import the factory from the timeout middleware to apply a custom value on a specific route:

```ts
import { createTimeout } from '../middleware/timeout';

router.get('/slow-endpoint', createTimeout(60_000), requireRole('admin'), myHandler);
```

---

## Error Format

All error responses follow this shape:

```json
{
  "success": false,
  "error": "<human-readable message>",
  "code": "<machine-readable error code>",
  "correlationId": "<optional request correlation ID>"
}
```

The `code` field provides a machine-readable error classification for programmatic error handling. The mapping from HTTP status to error code is:

| HTTP Status | Error Code                | Meaning                       |
| ----------- | ------------------------- | ----------------------------- |
| 400         | `VALIDATION_ERROR`        | Invalid input data            |
| 401         | `UNAUTHORIZED`            | Missing or invalid auth token |
| 403         | `FORBIDDEN`               | Insufficient permissions      |
| 404         | `NOT_FOUND`               | Resource not found            |
| 409         | `CONFLICT`                | Resource conflict             |
| 413         | `PAYLOAD_TOO_LARGE`       | Request body exceeds limits   |
| 415         | `UNSUPPORTED_MEDIA_TYPE`  | Invalid content type          |
| 500         | `INTERNAL_SERVER_ERROR`   | Server error                  |

**Note:** When an error is thrown with an explicit `code` property already set, that code takes precedence over the status-based mapping.

---

## Error Codes

When a request triggers a Soroban contract error, the API translates the on-chain error code into an appropriate HTTP status and returns a human-readable message. The `code` field in the response body will contain the snake_case `ErrorCode` constant (e.g. `PLAYER_NOT_FOUND`).

| Code | Error              | HTTP Status              | Description                                    | Resolution                                                      |
| ---- | ------------------ | ------------------------ | ---------------------------------------------- | --------------------------------------------------------------- |
| 1    | AlreadyInitialized | 409 Conflict             | Contract already initialized                   | No action needed; contract is ready                             |
| 2    | NotInitialized     | 503 Service Unavailable  | Contract not initialized                       | Admin must call `initialize` first                              |
| 3    | PlayerNotFound     | 404 Not Found            | Player ID does not exist                       | Verify `player_id` from the registration transaction            |
| 4    | InvalidValidator   | 403 Forbidden            | Caller is not a registered validator           | Admin must register the validator address first                 |
| 5    | MilestoneNotFound  | 404 Not Found            | Milestone ID does not exist                    | Refresh the milestone list and verify the ID                    |
| 6    | AlreadyVerified    | 409 Conflict             | Milestone already approved                     | No duplicate approvals needed; check milestone status           |
| 7    | InsufficientFee    | 402 Payment Required     | Payment is below the required contact fee      | Fetch the current fee via `get_contact_fee()` and retry         |
| 8    | NotSubscribed      | 402 Payment Required     | Scout has no active subscription               | Call `subscribe` before browsing premium data; or attempting to cancel an already-cancelled or expired subscription |
| 9    | Unauthorized       | 401 Unauthorized         | Caller is not authorized for this action       | Confirm you are signing with the correct Stellar account        |
| 10   | ContractPaused     | 503 Service Unavailable  | Contract is paused by the admin                | Wait for admin to call `unpause_contract()`                     |
| 11   | Overflow           | 500 Internal Server Error| Arithmetic overflow in fee calculation         | Use amounts within the safe u128 range                          |

### Endpoint Error Code Cross-Reference

| Endpoint | Possible Error Codes |
| -------- | -------------------- |
| `POST /api/players/register` | 2 (NotInitialized), 10 (ContractPaused) |
| `GET /api/players/:playerId` | 3 (PlayerNotFound) |
| `GET /api/players/:playerId/milestones` | 3 (PlayerNotFound), 5 (MilestoneNotFound) |
| `POST /api/validators/milestone` | 2 (NotInitialized), 4 (InvalidValidator), 10 (ContractPaused) |
| `POST /api/scouts/:wallet/contacts/:playerId/unlock` | 7 (InsufficientFee), 8 (NotSubscribed), 9 (Unauthorized), 10 (ContractPaused) |
| `GET /api/scouts/:wallet/subscription` | 8 (NotSubscribed) |
| `DELETE /api/scouts/:wallet/subscription` | 8 (NotSubscribed — no active subscription or already cancelled), 9 (Unauthorized), 10 (ContractPaused) |
| `GET /api/admin/fees` | 10 (ContractPaused) |
| `POST /api/admin/contract/pause` | 9 (Unauthorized), 2 (NotInitialized) |
| `POST /api/admin/contract/unpause` | 9 (Unauthorized), 2 (NotInitialized) |

### Cancel Subscription

`DELETE /api/scouts/:wallet/subscription` — Cancels a scout's active on-chain subscription.

**On-chain semantics:**
- The `cancel_subscription(scout)` entrypoint on the `subscription` contract marks the subscription as expired at the current ledger (no refund).
- Returns HTTP `402` with error code `NOT_SUBSCRIBED` (contract code 8) when:
  - the scout has never subscribed, or
  - the subscription has already expired naturally, or
  - the subscription was previously cancelled.
- The cancel is idempotent in the sense that a successfully cancelled subscription cannot be cancelled again (subsequent attempts return `NOT_SUBSCRIBED`).
- After cancellation `is_subscribed(scout)` returns `false` immediately.

**Response (success):**
```json
{ "success": true, "transactionId": "abc123..." }
```

**Response (no subscription):**
```json
{ "success": false, "error": "Scout has no active on-chain subscription", "code": "NOT_SUBSCRIBED" }
```

### Pause / Unpause Contract

`POST /api/admin/contract/pause` / `POST /api/admin/contract/unpause`

These endpoints invoke `pause(admin)` / `unpause(admin)` on the **subscription** contract via the platform keypair. The subscription contract's pause flag gates `subscribe`, `pay_to_contact`, and `withdraw_fees`. The `register` and `connection` contracts each have their own `pause`/`unpause` entrypoints that must be called separately if a full platform pause is needed.

**Behavior:**
- Calling `pause` when already paused is a no-op (returns success).
- Calling `unpause` when already active is a no-op (returns success).
- Only the admin address configured at contract initialization may call these.
- The platform backend routes these calls to the **subscription contract** (`SUBSCRIPTION_CONTRACT_ID`).

### Fee Balance Query

`GET /api/admin/fees` — Returns the accumulated platform fee balance from the subscription contract.

The underlying call is `get_fee_balance() → i128` on the `subscription` contract, which is a read-only simulation (no transaction submitted, no keypair required). The balance represents total fees accumulated from `subscribe` and `pay_to_contact` calls since the last `withdraw_fees`.

**Response:**
```json
{ "balanceStroops": "5000000", "balanceXLM": "0.5" }
```
