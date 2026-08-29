# ScoutOff Backend Documentation

Welcome to the ScoutOff backend documentation. This directory contains detailed guides on configuration, operations, security, and advanced features.

## Quick Start

- **Deploying the backend?** Start with [DEPLOYMENT.md](../DEPLOYMENT.md)
- **Setting up auth and secrets?** See [Secrets Rotation](docs/secrets-rotation.md)
- **Migrating to PostgreSQL?** Check [PostgreSQL Migration](docs/postgres-migration.md)

## Core Documentation

### Deployment & Configuration
- **[DEPLOYMENT.md](../DEPLOYMENT.md)** — Environment setup, contract ID fallback chain, build & start, database migrations, backups, and smoke tests
- **[Contract ID Configuration](../DEPLOYMENT.md#contract-id-configuration)** — Single-contract vs. multi-contract deployments, per-contract ID fallback logic

### Operations & Monitoring
- **[Admin Multi-Sig](admin-multisig.md)** — High-value operation approval workflows, action types, state machine, threshold/TTL configuration
- **[Rate Limiting](rate-limiting.md)** — Per-IP, per-wallet, and per-endpoint rate limiting; namespacing; fail-open policy
- **[Reindexing](reindexing.md)** — Replaying blockchain events, cursor management, progress monitoring, error recovery

### Security & Secrets
- **[Secrets Rotation](secrets-rotation.md)** — Managing and rotating JWT secrets, signing keys, webhook encryption keys, and policies

### Advanced Topics
- **[Authentication Flow](auth.md)** — Stellar challenge/response authentication, JWT token structure, key rotation
- **[Webhooks](webhooks.md)** — Event delivery, retry logic, signature verification, subscription management
- **[Tier Promotion](tier-promotion.md)** — Player tier advancement based on milestone approvals
- **[Performance](performance.md)** — Caching strategies, indexer lag tuning, database optimization
- **[PostgreSQL Migration](postgres-migration.md)** — Switching from SQLite to PostgreSQL, per-provider examples

## Feature Highlights

### Multi-Sig Admin Operations

High-value operations (pause contract, withdraw fees) require M-of-N approval:

```env
ADMIN_WALLETS=GABC...,GDEF...,GHIJ...
ADMIN_THRESHOLD=2
ADMIN_ACTION_TTL_MS=3600000
```

**Workflow:**
1. Admin proposes → `POST /api/admin/{action}/propose`
2. Co-signers approve → `POST /api/admin/actions/{id}/approve`
3. On threshold → operation executes automatically
4. View pending actions → `GET /api/admin/actions/pending`

See [admin-multisig.md](admin-multisig.md) for complete details.

### Contract ID Fallback Chain

Single-contract or multi-contract deployments via environment variables:

**Single-contract (default):**
```env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```

**Multi-contract (optional per-contract overrides):**
```env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
REGISTER_CONTRACT_ID=CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
PROGRESS_CONTRACT_ID=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
SUBSCRIPTION_CONTRACT_ID=CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
```

Fallback chain: specific ID → `CONTRACT_ID` → empty string.

**Known limitation:** Indexer currently assumes single contract; multi-contract indexing not yet supported.

See [DEPLOYMENT.md: Contract ID Configuration](../DEPLOYMENT.md#contract-id-configuration) for details.

### Rate Limiting

Multi-dimensional rate limiting with fail-open policy:

```env
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
AUTH_RATE_LIMIT_MAX=5
```

- **Per-IP:** 60 requests per 60 seconds
- **Per-wallet:** Same limits for authenticated endpoints
- **Auth-specific:** 5 auth attempts per 60 seconds (brute-force protection)
- **Fail-open:** If rate limiter errors, requests are allowed through

See [rate-limiting.md](rate-limiting.md) for configuration, namespacing, and 429 response details.

### Reindexing

Replay blockchain events for recovery or testing:

```bash
curl -X POST https://backend/api/admin/indexer/reindex \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -d '{ "fromLedger": 123456 }'
```

- Batches in ~100-ledger chunks with 50ms delay
- Deduplicates via `tx_hash` — safe to re-run
- Rewinds cursor on completion
- Single reindex at a time (singleton guard)

See [reindexing.md](reindexing.md) for monitoring, failure recovery, and operational workflows.

## Configuration Reference

### Environment Variables

See [DEPLOYMENT.md](../DEPLOYMENT.md) for a complete table and explanations.

**Key categories:**
- **Stellar/Soroban:** `CONTRACT_ID`, `HORIZON_URL`, `SOROBAN_RPC_URL`, `NETWORK`
- **Auth:** `JWT_SECRET`, `ADMIN_WALLETS`, `ADMIN_THRESHOLD`
- **Database:** `DB_DRIVER`, `DB_PATH`, `DATABASE_URL`, `DATABASE_SSL`
- **IPFS:** `PINATA_API_KEY`, `PINATA_SECRET`
- **Rate Limiting:** `RATE_LIMIT_ENABLED`, `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`
- **Admin:** `ADMIN_IP_ALLOWLIST`, `ADMIN_ACTION_TTL_MS`
- **Indexing:** `INDEXER_BACKFILL_FROM_LEDGER`, `INDEXER_LAG_WARN_THRESHOLD`

### Per-Environment Defaults

**Development:**
- All CORS origins allowed (`*`)
- Lenient rate limits (1000 req/min)
- Logging at debug level

**Staging:**
- Specific CORS origin (`https://staging.scoutoff.io`)
- Standard rate limits (60 req/min, 5 auth/min)
- Logging at info level
- Warnings if `ADMIN_WALLET` not set

**Production:**
- Restricted CORS origins (`https://app.scoutoff.io`, `https://scoutoff.io`)
- Standard rate limits
- Logging at warn level
- `ADMIN_WALLET` required; process fails to start without it

## Health & Monitoring

### Health Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness; includes Stellar RPC status |
| `GET /ready` | Readiness; checks IPFS connectivity |
| `GET /version` | Build info (package version, git commit) |

### Metrics

Recommended metrics to track:
- **HTTP 5xx error rate** — Errors per minute
- **Indexer lag** — Latest chain ledger − last indexed ledger
- **Rate limit hit rate** — 429 responses per minute
- **Database size** — SQLite file size growth
- **Auth token generation rate** — Tokens issued per minute

### Alerting

Set up alerts for:
- Consecutive `GET /health` failures (≥ 2)
- Indexer lag > 100 ledgers (exceeds default threshold)
- Rate limit errors (fail-open incidents)
- Database size growth > 100 MB/day (anomaly)

## Database

### Schema

- **events** — Indexed blockchain events (deduped by `tx_hash`)
- **players** — Registered player profiles
- **validators** — Admin-registered milestone validators
- **pending_milestones** — Submitted milestones awaiting approval
- **audit_log** — Administrative action history
- **pending_admin_actions** — Multi-sig proposals (for M-of-N approvals)
- **admin_action_signatures** — Signatures on pending actions

### Backups

Use `npm run backup-db` with destination path:

```bash
npm run backup-db
# Destination: local path, s3://bucket/path, or gs://bucket/path
DB_PATH=/data/scout-off.db BACKUP_DEST=s3://my-bucket/backups bash scripts/backup-db.sh
```

Backups include integrity verification and row count sidecars. See [DEPLOYMENT.md: Database Backups](../DEPLOYMENT.md#database-backups).

## Common Tasks

### Setting Up Multi-Admin Approvals (2-of-3)

1. Create three admin wallets (hardware wallets recommended)
2. Export the public keys (e.g., `GABC...`, `GDEF...`, `GHIJ...`)
3. Configure environment:
   ```env
   ADMIN_WALLETS=GABC...,GDEF...,GHIJ...
   ADMIN_THRESHOLD=2
   ADMIN_ACTION_TTL_MS=3600000
   ```
4. Restart backend
5. Test: Propose an action, verify it requires co-signing before execution

See [admin-multisig.md](admin-multisig.md#best-practices).

### Recovering From Indexer Lag

1. Check indexer logs: `grep "\[indexer\]" logs.txt | tail -20`
2. Verify external services (Soroban RPC, IPFS) are healthy
3. Initiate reindex from last known-good ledger:
   ```bash
   curl -X POST https://backend/api/admin/indexer/reindex \
     -H "Authorization: Bearer $TOKEN" \
     -d '{ "fromLedger": 123456 }'
   ```
4. Monitor `GET /health` until indexer lag returns to normal

See [reindexing.md](reindexing.md#operational-runbook).

### Rotating JWT Secrets

1. Generate a new secret: `openssl rand -hex 32`
2. Update environment:
   ```env
   JWT_SECRET_PREVIOUS=<old_secret>
   JWT_SECRET=<new_secret>
   ```
3. Deploy and monitor for failed authentications
4. After all sessions expire (TTL config), remove `JWT_SECRET_PREVIOUS` and redeploy

See [secrets-rotation.md](secrets-rotation.md#jwt-secret-rotation).

### Migrating to PostgreSQL

1. Set up PostgreSQL database and user
2. Configure connection string:
   ```env
   DB_DRIVER=postgres
   DATABASE_URL=postgresql://user:pass@host:5432/scoutoff
   DATABASE_SSL=true
   ```
3. Migrations auto-apply on first connection
4. Verify data integrity post-migration
5. Update backup script destination if using managed provider backups

See [postgres-migration.md](postgres-migration.md) for per-provider examples (RDS, Heroku, Supabase, etc.).

## Troubleshooting

### Backend fails to start

**Check:**
1. All required env vars are set (`CONTRACT_ID`, `JWT_SECRET`, etc.)
2. Database file is writable (SQLite) or connection string is valid (PostgreSQL)
3. Stellar RPC endpoints are reachable
4. Logs show specific error message

### High 5xx error rate

**Check:**
1. Indexer logs for errors (event processing issues)
2. Database queries for slow/locked tables
3. External service health (Stellar RPC, IPFS, Redis if used)
4. Rate limiting not causing cascading failures

### Indexer not progressing

**Check:**
1. Is indexer poll running? (Look for `[indexer]` log lines every 30 seconds)
2. Soroban RPC health and latency
3. Current lag via `GET /health`
4. Last successful event in `events` table

If stuck, initiate a reindex from a recent ledger.

### Admin operations blocked with "High-value operation requires multiple admin signatures"

**Check:**
1. `ADMIN_THRESHOLD` setting in environment
2. Admin JWT contains correct `role: "admin"` claim
3. If threshold > 1, ensure co-signer workflows are being followed

For immediate testing, set `ADMIN_THRESHOLD=1` to skip multi-sig.

## Contributing

When adding new features:

1. **Document configuration:** Add env vars to `.env.example` and [DEPLOYMENT.md](../DEPLOYMENT.md)
2. **Update feature docs:** Create or update docs files in this directory
3. **Add to this README:** Link the new docs from appropriate sections
4. **Audit log:** Add entries for high-value operations
5. **Test in staging:** Verify multi-env behavior (dev, staging, prod)

## References

- [Source Code](../src/)
- [Database Migrations](../db/)
- [GitHub Repository](https://github.com/scoutoff/scout-off-backend)
- [Stellar Documentation](https://developers.stellar.org/)
- [Soroban Documentation](https://soroban.stellar.org/)
