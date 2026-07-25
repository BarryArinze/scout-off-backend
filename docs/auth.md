# Authentication

This document describes the backend authentication flow for ScoutOff.
It covers SEP-10 challenge/response, JWT issuance, token claims, refresh behavior, logout, and example `curl` requests.

## SEP-10 Challenge / Response Flow

ScoutOff uses Stellar SEP-10 for wallet-based authentication.
The client proves ownership of a Stellar account by signing a server-issued challenge transaction.

### 1. Request a SEP-10 challenge

`GET /auth/challenge?account=G...`

Request a challenge XDR by passing the client Stellar account public key in the `account` query string.

Example:

```bash
curl "http://localhost:3000/auth/challenge?account=GABC123..." \
  -H "Accept: application/json"
```

Successful response:

```json
{
  "challenge": "AAAA...",
  "networkPassphrase": "Test SDF Network"
}
```

- `challenge` is a SEP-10 transaction XDR that must be signed by the client wallet.
- `networkPassphrase` indicates which Stellar network the challenge uses.

### 2. Sign the challenge and request a JWT

`POST /auth/token`

After signing the challenge transaction, submit the signed XDR to the backend.
The request body should include the signed `transaction` and optionally a `role` hint when requesting a specific role such as `validator`.

Example:

```bash
curl "http://localhost:3000/auth/token" \
  -H "Content-Type: application/json" \
  -d '{
    "transaction": "AAAA...",
    "role": "scout"
  }'
```

Successful response:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "account": "GABC123...",
  "expiresAt": 1710000000
}
```

- `token` is the JWT used for authenticated API requests.
- `account` is the authenticated Stellar account.
- `expiresAt` is the UNIX timestamp when the token expires.

## JWT Claims Structure

The backend issues JWTs with the following standard claims:

- `sub`: the Stellar account that authenticated the request.
- `role`: the assigned role for the token.
- `exp`: token expiration timestamp.

Example decoded payload:

```json
{
  "sub": "GABC123...",
  "role": "player",
  "iat": 1700000000,
  "exp": 1700086400
}
```

### Supported roles

The backend supports these token roles:

- `player`
- `scout`
- `validator`
- `admin`

The `role` may be assigned from the request or automatically elevated to `admin` if the authenticated account matches the configured `ADMIN_WALLET`.

## Token Refresh

`POST /auth/token` now returns **both** a short-lived access token and a
long-lived refresh token. Mobile clients and any client that needs to stay
authenticated across the access token's TTL should store the refresh token
securely (device keychain / secure storage — **never** `localStorage`) and
use it to obtain a new token pair silently.

### Access token TTL

The access token expires after `JWT_ACCESS_TTL_SECONDS` (default **15 minutes**,
configurable via environment variable). The `expiresAt` field in every token
response is the Unix timestamp when the access token expires.

### Refresh token TTL

The refresh token expires after **7 days**. After expiry the full SEP-10
challenge flow must be repeated.

### Token response shape (POST /auth/token)

```json
{
  "token": "eyJ...",
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "account": "GABC123...",
  "expiresAt": 1710000900
}
```

Both `token` and `accessToken` carry the same value. `token` is retained for
backwards compatibility with existing clients.

### POST /auth/refresh — silent re-authentication

Exchange a valid refresh token for a new access + refresh token pair.
**Refresh token rotation** is enforced: the submitted refresh token is revoked
immediately and a fresh one is returned. Using the same refresh token a second
time returns `401`.

Request:

```bash
curl -X POST "http://localhost:4000/auth/refresh" \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<your-refresh-token>" }'
```

Successful response (`200`):

```json
{
  "success": true,
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "expiresAt": 1710000900
}
```

Error responses:

| Status | Reason |
|--------|--------|
| `400` | `refreshToken` field missing from body |
| `401` | Token is expired, has an invalid signature, is not a refresh token, or has been revoked (used twice) |

### Refresh token lifecycle

```
POST /auth/token
  └─► { accessToken (15 min), refreshToken (7 days) }
          │
          │  (access token expires)
          ▼
POST /auth/refresh  { refreshToken: <old> }
  └─► { accessToken (new, 15 min), refreshToken (new, 7 days) }
          │  old refresh token is NOW REVOKED
          │
          │  (repeat as needed, up to 7 days from last full SEP-10 auth)
          ▼
POST /auth/logout   (revokes access + refresh tokens)
  └─► { success: true }
```

Key properties:

- Each refresh token can only be used **once** (rotation). Reuse returns `401`.
- Refresh tokens carry `type: 'refresh'` in their JWT payload so they cannot
  be used as bearer tokens on API routes.
- The server never persists refresh tokens — only revoked `jti` values are
  stored (in `revoked_tokens`), keeping server state minimal.
- All revoked `jti` entries are pruned once their `expires_at` passes.

## Logout

`POST /auth/logout` revokes both the caller's access token and (optionally) its
paired refresh token so neither can be reused after logout.

```bash
curl -X POST "http://localhost:4000/auth/logout" \
  -H "Authorization: Bearer <access-token>" \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "<your-refresh-token>" }'
```

- The `Authorization: Bearer` header is required (any valid role).
- The `refreshToken` body field is optional — omitting it only revokes the
  access token.
- After logout, any further use of the access token or the submitted refresh
  token returns `401`.

Successful response (`200`):

```json
{ "success": true, "message": "Logged out successfully" }
```

## Using the JWT for authenticated API requests

Protected endpoints require the header:

```
Authorization: Bearer <token>
```

Example request to a protected route:

```bash
curl "http://localhost:3000/api/admin/events" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

## Auth-related endpoints

### `GET /auth/challenge?account=G...`

- Purpose: request a SEP-10 challenge transaction for the given Stellar account.
- Authentication: none.
- Returns: challenge XDR and network passphrase.

### `POST /auth/token`

- Purpose: submit the signed SEP-10 challenge and receive a JWT access token
  and a refresh token.
- Authentication: none.
- Request body:
  - `transaction` (string): signed challenge XDR
  - `role` (optional string): requested role hint
- Returns: `accessToken`, `refreshToken`, authenticated `account`, and `expiresAt` timestamp.
  The legacy `token` field mirrors `accessToken` for backwards compatibility.

### `POST /auth/refresh`

- Purpose: exchange a valid refresh token for a new access + refresh token pair
  (rotation — the submitted token is revoked on success).
- Authentication: none (refresh token in request body).
- Request body:
  - `refreshToken` (string): a non-expired, non-revoked refresh token
- Returns: `accessToken`, `refreshToken`, `expiresAt`.
- Errors: `400` missing field; `401` invalid/expired/revoked token.

### `POST /auth/logout`

- Purpose: revoke the caller's access token and optionally their refresh token.
- Authentication: Bearer access token (any role).
- Request body (optional):
  - `refreshToken` (string): if provided, this refresh token is also revoked.
- Returns: `{ success: true }`.

### `POST /api/admin/introspect`

This admin route can be used to verify a token and inspect its payload.
It requires a valid admin JWT and is useful for debugging.

Example:

```bash
curl "http://localhost:3000/api/admin/introspect" \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "token": "<token-to-inspect>" }'
```

Successful response:

```json
{
  "success": true,
  "data": {
    "sub": "GABC123...",
    "role": "admin",
    "iat": 1700000000,
    "exp": 1700086400
  }
}
```
