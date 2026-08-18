# ScoutOff Backend API Documentation

All endpoints are served from the base URL configured via `PORT` (default: `4000`).

---

## Table of Contents

- [API Versioning](#api-versioning)
- [Authentication](#authentication)
- [Endpoints](#endpoints)
  - [Health](#health)
  - [Auth](#auth)
  - [Players](#players)
  - [Scouts](#scouts)
  - [Validators](#validators)
  - [Admin](#admin)
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
| `write:trial_offers` | `POST /scouts/:wallet/trial-offers` (and its deprecated alias `/trial-offer`) |
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

### Health

#### `GET /health`

Liveness check. No auth required.

**Response `200`**

```json
{
  "status": "ok",
  "healthStatus": {
    "stellar": "ok"
  }
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/health"
```

---

### Auth

#### `GET /auth/challenge?account=G...`

Returns a SEP-10 challenge XDR for the given Stellar account. No auth required.

**Query params**

| Param     | Type   | Required | Description             |
| --------- | ------ | -------- | ----------------------- |
| `account` | string | ✅       | Stellar public key (G…) |

**Response `200`**

```json
{
  "challenge": "<XDR string>",
  "networkPassphrase": "Test SDF Network ; September 2015"
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/auth/challenge?account=GPLAYER1EXAMPLEWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```

> `account` is a placeholder Stellar public key — substitute the real wallet requesting a challenge.

---

#### `POST /auth/token`

Submit a signed SEP-10 XDR to receive a JWT. No auth required.

**Request body**

```json
{
  "transaction": "<signed XDR string>",
  "role": "scout"
}
```

| Field         | Type   | Required | Description                                                          |
| ------------- | ------ | -------- | ---------------------------------------------------------------------|
| `transaction` | string | ✅       | The signed SEP-10 challenge XDR returned from `/auth/challenge`      |
| `role`        | string | ❌       | Requested role: `player`, `scout`, `validator`, or `admin`           |

**Response `200`**

```json
{
  "token": "<JWT>",
  "account": "GABC...XYZ",
  "expiresAt": 1700000000
}
```

**Example request**

```bash
curl -X POST "http://localhost:4000/auth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "transaction": "<signed-xdr-placeholder>",
    "role": "scout"
  }'
```

> `transaction` is a placeholder for the base64 XDR produced by signing the challenge from `/auth/challenge` with the account's Stellar keypair — it cannot be faked without a real signature.

---

### Players

#### `POST /api/players/register`

Pin player metadata to IPFS and return the content ID. No auth required.

**Request body**

```json
{
  "wallet": "GABC...XYZ",
  "position": "Midfielder",
  "region": "West Africa",
  "metadata": {
    "name": "Kwame Asante",
    "age": 19,
    "club": "Accra Lions FC",
    "highlightReels": ["QmXyz..."],
    "stats": { "topSpeed": "32 km/h" }
  }
}
```

**Response `201`**

```json
{
  "success": true,
  "data": {
    "metadataUri": "QmXyz...",
    "gatewayUrl": "https://gateway.pinata.cloud/ipfs/QmXyz..."
  }
}
```

**Example request**

```bash
curl -X POST "http://localhost:4000/api/players/register" \
  -H "Authorization: Bearer <player-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "GPLAYER1EXAMPLEWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "position": "Midfielder",
    "region": "West Africa",
    "metadata": {
      "name": "Kwame Asante",
      "age": 19,
      "club": "Accra Lions FC",
      "highlightReels": ["QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"],
      "stats": { "topSpeed": "32 km/h" }
    }
  }'
```

> `wallet` must be exactly 56 characters (a Stellar public key) and must match the wallet encoded in the caller's bearer token. Instead of `metadata`, you may alternatively pass a pre-pinned `metadataUri` (a valid IPFS CID) — the endpoint accepts one or the other, not both.

---

#### `GET /api/players`

Filter players by region, position, and minimum verified tier. No auth required.

**Query params**

| Param       | Type    | Required | Description                                                    |
| ----------- | ------- | -------- | -------------------------------------------------------------- |
| `region`    | string  | ❌       | Filter by region                                               |
| `position`  | string  | ❌       | Filter by position                                             |
| `minTier`   | integer | ❌       | Minimum progress level (0–3)                                   |
| `sortBy`    | string  | ❌       | Sort field: `tier` or `region`                                 |
| `sortOrder` | string  | ❌       | Sort direction: `asc` (default) or `desc`                      |
| `page`      | integer | ❌       | Page number (default: `1`, minimum: `1`)                       |
| `pageSize`  | integer | ❌       | Results per page (default: `20`, minimum: `1`, maximum: `100`) |

> **Pagination limits:** `pageSize` must be between 1 and 100. A value outside this range returns HTTP 400 — values are never silently clamped.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "player_id": "abc123",
      "wallet": "GABC...XYZ",
      "position": "Midfielder",
      "region": "West Africa",
      "progress_level": 2,
      "progress_tier_name": "Performance Milestones"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

**Response fields**

| Field | Type | Description |
| --- | --- | --- |
| `progress_level` | integer | Numeric progress tier (0–3) |
| `progress_tier_name` | string | Human-readable tier name: `Unverified`, `Verified Identity`, `Performance Milestones`, or `Elite Tier` |

**Error `400`** — invalid `minTier`

```json
{
  "success": false,
  "error": "minTier must be a number; valid values are 0=Unverified, 1=Verified, 2=Performance, 3=Elite"
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/players?region=West%20Africa&position=Midfielder&minTier=1&page=1&pageSize=20"
```

---

#### `GET /api/players/:playerId`

Retrieve a single player profile. No auth required for **active** players.

**Deactivated players** are hidden from everyone except the profile owner
(auth wallet matching the player's `player_id` or `wallet`) and admins — the
same shared decision (`src/utils/playerAccess.ts`) used by the milestones
endpoints and GraphQL. Unauthorized callers receive `404`.

**Response `200`**

```json
{
  "success": true,
  "data": {
    "player_id": "abc123",
    "wallet": "GABC...XYZ",
    "position": "Midfielder",
    "region": "West Africa",
    "progress_level": 2,
    "progress_tier_name": "Performance Milestones",
    "tierName": "tier.2.name",
    "tierDescription": "tier.2.description"
  }
}
```

**Error `404`**

```json
{ "success": false, "error": "Player not found" }
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/players/abc123"
```

---

#### `GET /api/players/:playerId/milestones`

Tamper-proof milestone history for a player. No auth required for **active**
players.

**Deactivated players** follow the same shared authorization as `GET
/api/players/:playerId` (`src/utils/playerAccess.ts`): owner/admin only,
otherwise `404` — identical behavior in REST and GraphQL.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "type": "milestone_approved",
      "ledger": 12345,
      "txHash": "abc...",
      "payload": {
        "player_id": "abc123",
        "milestone_type": "performance",
        "evidence_uri": "QmEvidence..."
      }
    }
  ]
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/players/abc123/milestones?sortBy=submittedAt&order=asc"
```

---

### Scouts

#### `GET /api/scouts/:wallet/subscription`

Check active subscription status for a scout. **Requires Bearer auth.**

**Response `200`**

```json
{
  "success": true,
  "data": {
    "active": true,
    "expiresAt": 1700000000
  }
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/scouts/GSCOUT1EXAMPLEWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/subscription" \
  -H "Authorization: Bearer <scout-jwt>"
```

> ⚠️ **Stubbed** — subscription data is read from indexed contract events; no write endpoint yet.

---

#### `GET /api/scouts/:wallet/contacts`

List players unlocked by a scout. **Requires Bearer auth.**

**Response `200`**

```json
{
  "success": true,
  "data": [{ "playerId": "abc123", "unlockedAt": 1700000000 }]
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/scouts/GSCOUT1EXAMPLEWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/contacts" \
  -H "Authorization: Bearer <scout-jwt>"
```

> ⚠️ **Stubbed** — contact data is read from indexed contract events; no write endpoint yet.

---

#### `GET /api/scouts/:wallet/payments`

Payment history for a scout, combining contact unlock payments and subscription payments. Only the owning scout or an admin may call this endpoint. **Requires Bearer auth (scout role).**

**Query params**

| Param      | Type    | Required | Description                                                                                  |
| ---------- | ------- | -------- | -------------------------------------------------------------------------------------------- |
| `type`     | string  | ❌       | Filter by payment type: `subscription` or `contact_unlock`                                   |
| `from`     | string  | ❌       | ISO 8601 start date (inclusive)                                                              |
| `to`       | string  | ❌       | ISO 8601 end date (inclusive)                                                                |
| `page`     | integer | ❌       | Page number (default: `1`)                                                                   |
| `pageSize` | integer | ❌       | Results per page (default: `50`, minimum: `1`, maximum: `100`)                               |
| `format`   | string  | ❌       | Response format: `json` (default) or `csv` — when `csv`, returns a downloadable CSV file    |

**Response `200` (JSON)**

```json
{
  "success": true,
  "data": [
    {
      "id": "tx-abc123",
      "type": "contact_unlock",
      "amount_xlm": "5",
      "player_id": "player-xyz",
      "tier": null,
      "tx_hash": "tx-abc123",
      "created_at": "2024-06-01T00:00:00.000Z",
      "transactionId": "tx-abc123",
      "amount": "5",
      "token": "XLM",
      "timestamp": "2024-06-01T00:00:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 50
}
```

**Response `200` (CSV)** — `Content-Type: text/csv; Content-Disposition: attachment; filename="payments.csv"`

```csv
id,type,amount_xlm,player_id,tier,tx_hash,created_at
"tx-abc123","contact_unlock","5","player-xyz","","tx-abc123","2024-06-01T00:00:00.000Z"
```

**Error `403`** — JWT wallet does not match the `:wallet` path parameter.

**Example requests**

```bash
# JSON — subscription payments only, date-filtered
curl "http://localhost:4000/api/scouts/GSCOUT.../payments?type=subscription&from=2024-01-01&to=2024-12-31" \
  -H "Authorization: Bearer <scout-jwt>"

# CSV export
curl "http://localhost:4000/api/scouts/GSCOUT.../payments?format=csv" \
  -H "Authorization: Bearer <scout-jwt>" \
  -o payments.csv
```

---

#### `GET /api/scouts/:wallet/recommendations`

Personalized player recommendations for a scout based on region and position preferences. **Requires Bearer auth (scout role).**

**Query params**

| Param      | Type    | Required | Description                                                                       |
| ---------- | ------- | -------- | --------------------------------------------------------------------------------- |
| `pageSize` | integer | ❌       | Number of recommendations to return (default: `20`, minimum: `1`, maximum: `100`) |
| `minTier`  | integer | ❌       | Minimum player progress level (0–3)                                               |

> **Pagination limits:** `pageSize` must be between 1 and 100. A value outside this range returns HTTP 400 — values are never silently clamped.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "player_id": "abc123",
      "wallet": "GABC...XYZ",
      "position": "Midfielder",
      "region": "West Africa",
      "progress_level": 2
    }
  ]
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/scouts/GSCOUT1EXAMPLEWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/recommendations?pageSize=20&minTier=1" \
  -H "Authorization: Bearer <scout-jwt>"
```

#### `POST /api/scouts/:wallet/trial-offers`

Submit a trial offer to a player. **This is the canonical trial-offer submission endpoint.** **Requires Bearer auth (scout role, wallet must match the authenticated account) and the `write:trial_offers` API-key scope.**

The request is validated, submitted on-chain via `log_trial_offer`, indexed into `trial_offer_events`, persisted to `trial_offers` as a `pending` offer, promotes the player to Elite Tier (level 3), and broadcasts the `trial_offer_logged` and `milestone_approved` SSE events. Supports the `Idempotency-Key` header to make retries safe.

**Body**

| Field        | Type   | Required | Description                                           |
| ------------ | ------ | -------- | ----------------------------------------------------- |
| `playerId`   | string | ✅       | The target player's on-chain identifier               |
| `detailsUri` | string | ✅       | Offer details — must be an `ipfs://` or `https://` URI |

**Response `201`**

```json
{
  "success": true,
  "data": {
    "offerId": "offer-1750000000-abc123",
    "transactionId": "a1b2c3...",
    "scout": "GSCOUT...",
    "playerId": "abc123",
    "detailsUri": "ipfs://QmExample",
    "createdAt": 1750000000,
    "tierPromoted": true,
    "newTier": 3
  }
}
```

| Status | Meaning                                                            |
| ------ | ------------------------------------------------------------------ |
| `400`  | Body failed validation (missing `playerId`, non-IPFS/HTTPS `detailsUri`) |
| `402`  | Scout has no active subscription and has not unlocked this contact |
| `403`  | Wallet does not match the authenticated account                    |
| `404`  | Player not found                                                   |

**Example request**

```bash
curl -X POST "http://localhost:4000/api/scouts/GSCOUT1EXAMPLEWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/trial-offers" \
  -H "Authorization: Bearer <scout-jwt>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 6b1f..." \
  -d '{ "playerId": "abc123", "detailsUri": "ipfs://QmExample" }'
```

#### `POST /api/scouts/:wallet/trial-offer` (deprecated)

> **Deprecated (#1034).** This singular path is an **alias** of `POST /api/scouts/:wallet/trial-offers` and is kept only for existing clients. It runs the exact same handler, so validation, persistence, tier promotion, SSE broadcast, response body and error codes are identical to the canonical endpoint above. Calling it emits a `warn`-level log entry:
>
> ```
> [deprecation] POST /api/scouts/:wallet/trial-offer called — prefer POST /api/scouts/:wallet/trial-offers. The singular path is an alias and will be removed in a future release.
> ```
>
> Clients should migrate to the plural path. Note that before #1034 this route did **not** persist the offer, promote the player's tier, or broadcast SSE, and its `data` object carried a `playerTier` field; it now returns the canonical response shape shown above.

---

### Validators

#### `POST /api/validators/milestone`

Pin milestone evidence to IPFS and return the CID. **Requires Bearer auth (validator role).**

**Request body**

```json
{
  "playerId": "abc123",
  "milestoneType": "performance",
  "evidenceUri": "ipfs://QmEvidence1234567890abcdefghijklmnopqrstuvwx"
}
```

| Field           | Type   | Required | Description                                                    |
| --------------- | ------ | -------- | ---------------------------------------------------------------|
| `playerId`      | string | ✅       | Target player's ID                                             |
| `milestoneType` | string | ✅       | One of `identity`, `performance`, `trial_offer`                |
| `evidenceUri`   | string | ✅       | Evidence location — must start with `ipfs://` or `https://`    |

**Response `201`**

```json
{
  "success": true,
  "data": {
    "evidenceUri": "QmEvidence...",
    "gatewayUrl": "https://gateway.pinata.cloud/ipfs/QmEvidence..."
  }
}
```

**Example request**

```bash
curl -X POST "http://localhost:4000/api/validators/milestone" \
  -H "Authorization: Bearer <validator-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "abc123",
    "milestoneType": "performance",
    "evidenceUri": "ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"
  }'
```

---

#### `GET /api/validators/milestones/pending`

List pending milestone approvals. **Requires Bearer auth (validator role).**

Also available as `GET /api/validators/:wallet/milestones/pending` to filter by a specific validator wallet.

**Query params**

| Param      | Type    | Required | Description                                                    |
| ---------- | ------- | -------- | -------------------------------------------------------------- |
| `region`   | string  | ❌       | Filter by player region                                        |
| `position` | string  | ❌       | Filter by player position                                      |
| `playerId` | string  | ❌       | Filter by specific player ID                                   |
| `page`     | integer | ❌       | Page number (default: `1`, minimum: `1`)                       |
| `pageSize` | integer | ❌       | Results per page (default: `20`, minimum: `1`, maximum: `100`) |

> **Pagination limits:** `pageSize` must be between 1 and 100. A value outside this range returns HTTP 400 — values are never silently clamped.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "milestoneId": "m001",
      "playerId": "abc123",
      "milestoneType": "performance",
      "evidenceUri": "QmEvidence...",
      "submittedAt": 1700000000
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/validators/milestones/pending?region=West%20Africa&position=Midfielder&page=1&pageSize=20" \
  -H "Authorization: Bearer <validator-jwt>"
```

Filtered by a specific validator wallet:

```bash
curl -X GET "http://localhost:4000/api/validators/GVALIDATOR1EXAMPLEWALLETXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/milestones/pending" \
  -H "Authorization: Bearer <validator-jwt>"
```

> ⚠️ **Stubbed** — returns events indexed from the contract; approval must be submitted on-chain.

---

### Admin

#### `GET /api/admin/stats`

Platform-wide counts. **Requires Bearer auth (admin role).**

**Response `200`**

```json
{
  "success": true,
  "data": {
    "players": 42,
    "milestones": 130,
    "subscriptions": 17,
    "events": 500
  }
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/admin/stats" \
  -H "Authorization: Bearer <admin-jwt>"
```

---

#### `GET /api/admin/events`

All indexed contract events. **Requires Bearer auth (admin role).**

**Query params**

| Param       | Type    | Required | Description                                              |
| ----------- | ------- | -------- | -------------------------------------------------------- |
| `startDate` | string  | ❌       | ISO date string — filter events on or after this date    |
| `endDate`   | string  | ❌       | ISO date string — filter events on or before this date   |
| `eventType` | string  | ❌       | Filter by event type (e.g. `player_registered`)          |
| `page`      | integer | ❌       | Page number (minimum: `1`)                               |
| `pageSize`  | integer | ❌       | Results per page (minimum: `1`, maximum: `100`)          |
| `limit`     | integer | ❌       | Alias for `pageSize` (takes precedence if both provided) |
| `offset`    | integer | ❌       | Row offset (alternative to `page`/`pageSize`)            |

> **Pagination limits:** `pageSize` and `limit` must be between 1 and 100. A value outside this range returns HTTP 400 — values are never silently clamped. The default page size is `20` when neither `limit` nor `pageSize` is provided.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "type": "player_registered",
      "ledger": 12345,
      "txHash": "abc...",
      "payload": {}
    }
  ],
  "total": 50,
  "limit": 20,
  "offset": 0
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/admin/events?startDate=2024-01-01&endDate=2024-12-31&eventType=player_registered&limit=20&offset=0" \
  -H "Authorization: Bearer <admin-jwt>"
```

---

#### `GET /api/admin/events/export`

Streams all indexed contract events as a CSV file using a Node.js streaming pipeline. **Requires Bearer auth (admin role).**

Unlike a buffered response, this endpoint reads rows from the `events` table one at a time via a `better-sqlite3` cursor (`Statement.iterate()`) and writes each CSV line to the HTTP response as it is produced. Memory usage is **bounded and roughly constant** regardless of table size — exporting 1 million rows consumes less than a few MB of heap.

**Query params** (identical semantics to `GET /api/admin/events`)

| Param       | Type   | Required | Description                                                    |
| ----------- | ------ | -------- | -------------------------------------------------------------- |
| `startDate` | string | ❌       | ISO 8601 — inclusive lower bound on the event's indexed time   |
| `endDate`   | string | ❌       | ISO 8601 — inclusive upper bound on the event's indexed time   |
| `eventType` | string | ❌       | Filter to a single contract event type (e.g. `player_registered`) |

**Response headers**

| Header               | Value                                        |
| -------------------- | -------------------------------------------- |
| `Content-Type`       | `text/csv`                                   |
| `Content-Disposition`| `attachment; filename="events.csv"`          |
| `Transfer-Encoding`  | `chunked` (set by Node.js HTTP automatically)|

**Response `200`** — CSV stream, columns: `event_type`, `ledger`, `timestamp`, `payload`

```csv
event_type,ledger,timestamp,payload
player_registered,12345,1700000000,"{""wallet"":""G...""}"
milestone_approved,12346,1700000060,"{}"
__EOF__,2,,
```

The last line is always `__EOF__,<row_count>,,`. Clients should verify this line is present to detect truncated exports (e.g. caused by a dropped connection mid-stream).

**CSV escaping** — fields follow RFC 4180: any value containing a comma, double-quote, or newline is wrapped in double-quotes with internal double-quotes doubled (`"` → `""`).

**Backpressure** — the export loop pauses DB reads whenever the HTTP socket buffer is full (waits for the `drain` event) so a slow client cannot cause unbounded memory growth on the server.

**Consistency** — the cursor holds a snapshot of the `events` table as of the first row read. Rows inserted by the background indexer after the cursor opens are excluded — no duplicates and no skipped rows within the snapshot boundary.

**Response `400`** — invalid `startDate`/`endDate`, or `startDate` after `endDate`.

**Example request**

```bash
# Stream all events to a local file
curl -X GET "http://localhost:4000/api/admin/events/export" \
  -H "Authorization: Bearer <admin-jwt>" \
  --output events.csv

# Filter by type and date range
curl -X GET "http://localhost:4000/api/admin/events/export?eventType=player_registered&startDate=2024-01-01T00:00:00Z&endDate=2024-12-31T23:59:59Z" \
  -H "Authorization: Bearer <admin-jwt>" \
  --output filtered.csv
```

---

#### `GET /api/admin/fees`

Fee withdrawal history. **Requires Bearer auth (admin role).**

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "type": "fees_withdrawn",
      "ledger": 12399,
      "txHash": "def...",
      "payload": { "amount": "5000000", "recipient": "GADMIN..." }
    }
  ]
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/admin/fees" \
  -H "Authorization: Bearer <admin-jwt>"
```

---

#### `POST /api/admin/fees/withdraw`

Withdraw accumulated platform fees from the Soroban contract to a treasury address. **Requires Bearer auth (admin role).**

This is the fully-specified withdrawal endpoint. It queries the contract's live fee balance before submitting, enforces multi-sig when `ADMIN_THRESHOLD > 1`, prevents duplicate submissions via an idempotency key, and records every confirmed withdrawal in the `fee_withdrawals` table.

**Request headers**

| Header            | Required | Description                                                                 |
| ----------------- | -------- | --------------------------------------------------------------------------- |
| `Authorization`   | ✅       | `Bearer <admin-jwt>`                                                        |
| `Idempotency-Key` | ❌       | Opaque string (e.g. UUID). Repeat requests with the same key return the cached result (24-hour TTL). |

**Request body**

| Field             | Type           | Required | Description                                                              |
| ----------------- | -------------- | -------- | ------------------------------------------------------------------------ |
| `treasuryAddress` | string         | ✅       | Valid Stellar public key (G…) — destination for the withdrawn fees       |
| `amountStroops`   | string\|number | ✅       | Positive integer in stroops. Must be ≤ the contract's current fee balance |

**Response `200`** — withdrawal confirmed on-chain

```json
{
  "success": true,
  "data": {
    "transactionId": "abc123...",
    "treasuryAddress": "GTREASURY...",
    "amountStroops": "500000000",
    "recipient": "GTREASURY...",
    "amount": "500000000",
    "token": "XLM"
  }
}
```

**Response `202`** — multi-sig required (`ADMIN_THRESHOLD > 1`); action queued for co-signing

```json
{
  "success": true,
  "message": "Fee withdrawal proposed, awaiting 1 more admin signature(s)",
  "data": {
    "actionId": "clxyz...",
    "collectedSignatures": 1,
    "requiredSignatures": 2,
    "treasuryAddress": "GTREASURY...",
    "amountStroops": "500000000"
  }
}
```

**Error responses**

| Status | Condition                                                           |
| ------ | ------------------------------------------------------------------- |
| `400`  | `treasuryAddress` is not a valid Stellar public key, or `amountStroops` is missing / not a positive integer |
| `401`  | Missing or expired Bearer token                                     |
| `403`  | Caller does not have the `admin` role, or wallet not in `ADMIN_WALLETS` |
| `409`  | No fees available (`NO_FEES`), contract paused (`CONTRACT_PAUSED`), or a concurrent withdrawal is already in progress |
| `422`  | `amountStroops` exceeds the contract's current fee balance          |
| `503`  | Transient RPC / network error — safe to retry                       |

**Example requests**

```bash
# Single-admin withdrawal
curl -X POST "http://localhost:4000/api/admin/fees/withdraw" \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{ "treasuryAddress": "GTREASURY...", "amountStroops": "500000000" }'

# Idempotent retry — returns the same 200 response without re-submitting
curl -X POST "http://localhost:4000/api/admin/fees/withdraw" \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{ "treasuryAddress": "GTREASURY...", "amountStroops": "500000000" }'
```

---

#### `GET /api/admin/audit`

Admin audit log of actions performed via the API. **Requires Bearer auth (admin role).**

**Query params**

| Param       | Type    | Required | Description                                                    |
| ----------- | ------- | -------- | -------------------------------------------------------------- |
| `startDate` | string  | ❌       | ISO date string — filter logs on or after this date            |
| `endDate`   | string  | ❌       | ISO date string — filter logs on or before this date           |
| `action`    | string  | ❌       | Filter by action type (e.g. `milestone_submitted`)             |
| `limit`     | integer | ❌       | Results per page (default: `20`, minimum: `1`, maximum: `100`) |
| `offset`    | integer | ❌       | Row offset from start (default: `0`, minimum: `0`)             |

> **Pagination limits:** `limit` must be between 1 and 100. A value outside this range returns HTTP 400 — values are never silently clamped.

**Response `200`**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "action": "milestone_submitted",
      "admin_wallet": "GADMIN...",
      "query_params": { "playerId": "abc123" },
      "created_at": "2024-03-15T12:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/admin/audit?startDate=2024-01-01&endDate=2024-12-31&action=milestone_submitted&limit=20&offset=0" \
  -H "Authorization: Bearer <admin-jwt>"
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

## Stubbed Routes

The following routes currently return data sourced entirely from indexed on-chain events and have no corresponding write/mutation endpoint in the backend:

| Route                                    | Reason                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/scouts/:wallet/subscription`   | Subscription state managed on-chain via `subscribe()`; backend is read-only   |
| `GET /api/scouts/:wallet/contacts`       | Contact unlocks managed on-chain via `pay_to_contact()`; backend is read-only |
| `GET /api/validators/milestones/pending` | Milestone approval is an on-chain transaction; backend only indexes events    |

---

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
  "error": "<human-readable message>"
}
```

Common HTTP status codes:

| Code | Meaning                       |
| ---- | ----------------------------- |
| 400  | Validation error              |
| 401  | Missing or invalid auth token |
| 403  | Insufficient permissions      |
| 404  | Resource not found            |
| 500  | Internal server error         |

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
