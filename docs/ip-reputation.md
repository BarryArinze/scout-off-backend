# IP Reputation

The backend scores every client IP on a **0–100 reputation scale** (higher =
worse) and applies progressive penalties as the score climbs. It is an
additional security layer on top of the existing rate-limit middleware, and it
is what makes a misbehaving client (scanner, credential-stuffer, or a buggy
client hammering the API) get delayed or blocked while legitimate traffic is
untouched.

The implementation lives in `src/services/ipReputation.ts` (scoring) and
`src/middleware/ipReputation.ts` (request handling). Scoring is enabled by
default and can be switched off with `IP_REPUTATION_ENABLED=false`.

## Scoring inputs

Points are added to an IP's score at the following sites:

| Source                        | Points | When                                                                 |
| ----------------------------- | ------ | -------------------------------------------------------------------- |
| `RATE_LIMIT_HIT`              | 5      | A request returns `429` (rate-limit middleware or reputation block)  |
| `ERROR_4XX`                   | 1      | A request returns any other 4xx (validation errors, not-found, etc.) |
| `ERROR_5XX`                   | 2      | A request returns a 5xx response                                     |
| `AUTH_FAILURE`                | 10     | A request returns `401`/`403` (bad or missing credentials)           |
| `BAD_USER_AGENT`              | 20     | The `User-Agent` matches a known scanner/bot signature               |

Points are applied **after** the response is written (via a `res.finish` hook),
so a single request that is both a 401 and a rate-limit hit contributes its
points exactly once per response. Scores are clamped to `[0, 100]`.

### Bad user-agent list

A request whose `User-Agent` contains any of these substrings (case-insensitive)
immediately receives `BAD_USER_AGENT` points:

`sqlmap`, `nikto`, `masscan`, `nmap`, `zgrab`, `dirbuster`, `gobuster`,
`hydra`, `nessus`, `openvas`

## Tiers and their effects

Thresholds are defined in code as `SCORE_DELAY_THRESHOLD = 50`,
`SCORE_RESTRICT_THRESHOLD = 75`, and `SCORE_BLOCK_THRESHOLD = 90`.

| Score      | Tier        | Effect                                                                 |
| ---------- | ----------- | ---------------------------------------------------------------------- |
| 0–49       | `normal`    | No penalty — requests pass through untouched                            |
| 50–74      | `degraded`  | **500 ms response delay** injected before the request is handled        |
| 75–89      | `restricted`| Advisory header `X-RateLimit-Reputation-Limit: 5` set on every response; the client is expected to back off to ~5 req/min (enforcement remains the existing rate-limit middleware) |
| 90–100     | `blocked`   | **Immediate `429`** for every request: `{ "success": false, "error": "Too many requests — your IP has been temporarily blocked." }` |

Blocked and penalised requests are counted in Prometheus metrics
(`ip_reputation_blocked_total`, `ip_reputation_penalised_total`, scraped from
`GET /metrics`).

## Decay

Scores decay **10% per hour** to forgive transient spikes: an IP that behaved
badly once and then went quiet returns to `normal` on its own.

- Decay is compound: after `n` full hours a score becomes
  `round(score × 0.9ⁿ)`.
- The decay sweep runs hourly (`DECAY_INTERVAL_MS`).
- An entry whose score reaches `0` is removed entirely (a clean IP costs
  nothing to track).
- **Pinned** IPs (admin whitelist/blacklist) are immune to decay — see below.

## Admin controls (whitelist / blacklist / override)

Both endpoints require a Bearer JWT with the `admin` role. Admin routes are
also subject to `ADMIN_IP_ALLOWLIST` if that is configured.

### `GET /api/admin/ip-reputation/:ip`

Inspect the current reputation record for an IP.

```
GET /api/admin/ip-reputation/203.0.113.7
```

```json
{
  "success": true,
  "data": {
    "score": 65,
    "lastSeen": 1785000000000,
    "pinned": false
  }
}
```

`data` is `null` if the IP has no record (i.e. it is clean and has never been
penalised — treat a missing record as score `0`).

### `POST /api/admin/ip-allowlist`

Manually pin an IP to a fixed score. A pinned IP is **immune to both score
increments and decay** until it is re-pinned.

| Body `score` | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `0`          | **Whitelist** — the IP is pinned clean and can never be penalised   |
| `100`        | **Blacklist** — the IP is pinned blocked and always gets an instant `429` |
| any `0–100`  | Admin override — pin to an arbitrary score                          |

```
POST /api/admin/ip-allowlist
Content-Type: application/json
Authorization: Bearer <admin-jwt>

{ "ip": "203.0.113.7", "score": 0 }
```

```json
{ "success": true, "data": { "ip": "203.0.113.7", "score": 0 } }
```

Validation errors (missing/invalid `ip`, score outside `0–100`) return `400`.

## Known limitation: in-memory store

The reputation store is an **in-memory `Map` in each process**:

- Scores are **not shared across backend instances** — in a load-balanced,
  multi-instance deployment each instance keeps its own scoreboard, so the same
  IP can be at different tiers on different instances until the traffic pattern
  converges them.
- **Restarting the process clears all scores and pins** — whitelists and
  blacklists must be re-applied after a restart.

Redis-backing the store (shared scores and atomic cross-instance updates) is
tracked in [issue #1100](https://github.com/scout-off/scout-off-backend/issues/1100).

## Why is my client delayed/blocked?

Walk the score backwards: a `429` from the backend means the IP is pinned to
`90+` **or** reached the block tier through repeated `AUTH_FAILURE` (10),
`BAD_USER_AGENT` (20), or `RATE_LIMIT_HIT` (5) events. Check the current score
with `GET /api/admin/ip-reputation/:ip`, fix the root cause on the client
(valid credentials, a real `User-Agent`, respecting `429`/`Retry-After`), and
either wait for the 10%/hour decay or pin the IP back to `0` if it was a false
positive.
