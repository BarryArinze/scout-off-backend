# ScoutOff Backend API Documentation

All endpoints are served from the base URL configured via `PORT` (default: `4000`).

---

## Table of Contents

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

## Authentication

Most protected routes require a **Bearer JWT** obtained from `POST /auth/token`.

```
Authorization: Bearer <token>
```

Tokens are issued after a successful SEP-10 Stellar wallet challenge/response flow.

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
      "progress_level": 2
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

**Error `400`** — invalid `minTier`

```json
{
  "success": false,
  "error": "minTier 5 is out of range. Valid values: 0, 1, 2, 3."
}
```

**Example request**

```bash
curl -X GET "http://localhost:4000/api/players?region=West%20Africa&position=Midfielder&minTier=1&page=1&pageSize=20"
```

---

#### `GET /api/players/:playerId`

Retrieve a single player profile. No auth required.

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

Tamper-proof milestone history for a player. No auth required.

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

Streams all indexed contract events as a CSV file. **Requires Bearer auth (admin role).**

Query params (identical semantics to `GET /api/admin/events`): `startDate`, `endDate` (ISO 8601, inclusive), `eventType`.

Rows are read from the database in bounded pages and written to the response as each page
arrives, so memory usage does not grow with the number of events.

**Response `200`** — `Content-Type: text/csv`, `Content-Disposition: attachment; filename="events.csv"`
```csv
event_type,ledger,timestamp,payload
player_registered,12345,1700000000,"{}"
milestone_approved,12346,1700000060,"{}"
```

**Response `400`** — invalid `startDate`/`endDate`, or `startDate` after `endDate`.

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

## Stubbed Routes

The following routes currently return data sourced entirely from indexed on-chain events and have no corresponding write/mutation endpoint in the backend:

| Route                                    | Reason                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/scouts/:wallet/subscription`   | Subscription state managed on-chain via `subscribe()`; backend is read-only   |
| `GET /api/scouts/:wallet/contacts`       | Contact unlocks managed on-chain via `pay_to_contact()`; backend is read-only |
| `GET /api/validators/milestones/pending` | Milestone approval is an on-chain transaction; backend only indexes events    |

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
| 8    | NotSubscribed      | 402 Payment Required     | Scout has no active subscription               | Call `subscribe` before browsing premium data                   |
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
| `POST /api/admin/contract/pause` | 9 (Unauthorized), 1 (AlreadyInitialized) |
| `POST /api/admin/contract/unpause` | 9 (Unauthorized), 10 (ContractPaused) |
