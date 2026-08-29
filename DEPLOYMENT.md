# Deployment Notes — ScoutOff Backend

## Environment Setup

Copy `.env.example` to `.env` and fill in all required values before starting the server.

> [!NOTE]
> For instructions and policies on managing, securing, and rotating long-lived secrets (such as JWT secrets, Pinata credentials, and platform signing keys), see the [Secrets Rotation Policy](docs/secrets-rotation.md).

| Variable | Required | Notes |
|---|---|---|
| `CONTRACT_ID` | ✅ | Deployed Soroban contract address; fallback for per-contract IDs (see [Contract ID Configuration](#contract-id-configuration)) |
| `JWT_SECRET` | ✅ | Min 32 chars; rotate on compromise |
| `HORIZON_URL` | ✅ | e.g. `https://horizon-testnet.stellar.org` |
| `SOROBAN_RPC_URL` | ✅ | e.g. `https://soroban-testnet.stellar.org` |
| `NETWORK` | ✅ | `testnet` or `mainnet` |
| `PINATA_API_KEY` / `PINATA_SECRET` | ✅ | IPFS upload credentials |
| `DB_PATH` | — | SQLite file path (default: `scout-off.db`) |
| `PORT` | — | API port (default: `4000`) |
| `LOG_LEVEL` | — | `debug` / `info` / `warn` / `error` |
| `LOG_SKIP_PATHS` | — | Comma-separated paths requestLogger silences (default: health + metrics probes) |
| `LOG_SAMPLE_RATE` | — | Float 0–1 sample rate for non-skipped paths (default: `1` = log all) |
| `STELLAR_HEALTH_CHECK` | — | Set `false` in staging to skip Stellar RPC check |
| `TRUSTED_PROXY_COUNT` | — | Number of trusted reverse proxies (default: `1`). Set to the exact number of proxy hops between the internet and this server. **Fail-safe**: if the observed `X-Forwarded-For` chain has fewer entries than this value implies, `extractClientIp()` falls back to the raw socket address rather than trusting the attacker-controlled leftmost value. A chain shorter than expected (direct connection bypassing a proxy, or a client crafting a short header) will therefore appear to come from the connecting IP, not a spoofed address. |
| `ADMIN_WALLET` | — | Single admin wallet address (for backward compatibility) |
| `ADMIN_WALLETS` | — | Comma-separated list of admin wallet addresses (e.g., `GABC...,GDEF...`) |
| `ADMIN_THRESHOLD` | — | Number of admin signatures required for high-value operations (default: `1`) |
| `ADMIN_ACTION_TTL_MS` | — | TTL for pending admin multi-sig actions in milliseconds (default: `3600000` = 1 hour) |
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated CORS allowed origins (defaults per env: `*` in dev, `https://staging.scoutoff.io` in staging, `https://app.scoutoff.io,https://scoutoff.io` in prod) |
| `ADMIN_IP_ALLOWLIST` | — | Comma-separated list of **IPv4** addresses/CIDR ranges allowed to reach admin endpoints (e.g. `192.168.1.0/24,10.0.0.1`). Unset/empty disables the check. IPv6 is not supported yet — any IPv6 client IP is rejected with 403 regardless of this setting (fail closed). |
| `RATE_LIMIT_ENABLED` | — | Enable rate limiting (default: `true`). See [docs/rate-limiting.md](docs/rate-limiting.md). |
| `RATE_LIMIT_WINDOW_MS` | — | Rate limit window in milliseconds (default: `60000`). See [docs/rate-limiting.md](docs/rate-limiting.md). |
| `RATE_LIMIT_MAX` | — | Max requests per window per IP (default: `60`). See [docs/rate-limiting.md](docs/rate-limiting.md). |
| `AUTH_RATE_LIMIT_WINDOW_MS` | — | Auth rate limit window (default: `60000`). See [docs/rate-limiting.md](docs/rate-limiting.md). |
| `AUTH_RATE_LIMIT_MAX` | — | Max auth requests per window (default: `5`). See [docs/rate-limiting.md](docs/rate-limiting.md). |

## Build & Start

```bash
npm install
npm run build      # compiles TypeScript → dist/
npm start          # runs dist/index.js
```

For development with hot-reload:

```bash
npm run dev
```

## Contract ID Configuration

The backend supports both **single-contract** and **multi-contract** deployment models via a fallback chain in environment variables.

### The Fallback Chain

When a component needs a contract ID, it looks up the hierarchy in this order:

1. **Specific contract ID** (e.g., `REGISTER_CONTRACT_ID`, `PROGRESS_CONTRACT_ID`, etc.)
2. **Fallback: `CONTRACT_ID`** (universal contract address)
3. **Empty string** (defaults to empty if nothing is set)

This design enables two deployment patterns:

#### Single-Contract Deployments (Default)

In a single-contract deployment, all functionality lives in one deployed Soroban contract:

```env
# .env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

# No per-contract IDs needed; all operations use CONTRACT_ID above
```

**Example use case:** Development, testing, or smaller deployments where one contract handles player registration, progress tracking, subscriptions, and connections.

#### Multi-Contract Deployments

In a multi-contract deployment, separate concerns are split across different contracts:

```env
# .env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

# Optional per-contract overrides (each defaults to CONTRACT_ID above if not set)
REGISTER_CONTRACT_ID=CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
PROGRESS_CONTRACT_ID=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
SUBSCRIPTION_CONTRACT_ID=CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
CONNECTION_CONTRACT_ID=CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE
```

**Example use case:** Production deployments where each domain has its own audited contract for better isolation, security, and independent upgrades.

### When to Set Each Per-Contract ID

| Variable | Purpose | When to Set |
|---|---|---|
| `REGISTER_CONTRACT_ID` | Player registration contract | Multi-contract setup with separate registration logic |
| `PROGRESS_CONTRACT_ID` | Milestone/progress tracking contract | Multi-contract setup with separate progress tracking |
| `SUBSCRIPTION_CONTRACT_ID` | Subscription management contract | Multi-contract setup with separate subscription logic |
| `CONNECTION_CONTRACT_ID` | Connection/relationship contract | Multi-contract setup with separate connection logic |

If any per-contract ID is **not** set, the system falls back to `CONTRACT_ID`. If `CONTRACT_ID` itself is unset, operations using that contract will fail (the system requires at least one defined contract ID).

### Known Limitation: Indexer Single-Contract Assumption

The event indexer (`src/services/indexer.ts`) currently assumes a **single contract** and only monitors `config.contractId` for events. In multi-contract deployments, events emitted by separate contracts (e.g., `PROGRESS_CONTRACT_ID`, `SUBSCRIPTION_CONTRACT_ID`) are **not indexed**.

**Workaround:** For multi-contract deployments, deploy separate indexer instances for each contract, each pointing to a different `CONTRACT_ID`.

**Tracking:** See [GitHub Issue #XXX](https://github.com/scoutoff/scout-off-backend/issues/XXX) for planned multi-contract indexer support.

### Configuration Examples

**Single-contract (simplest):**
```env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
NODE_ENV=production
NETWORK=mainnet
# ... other required env vars
```

**Multi-contract with per-contract IDs:**
```env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
REGISTER_CONTRACT_ID=CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
PROGRESS_CONTRACT_ID=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
SUBSCRIPTION_CONTRACT_ID=CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD
NODE_ENV=production
NETWORK=mainnet
# ... other required env vars
```

**Hybrid (partial multi-contract):**
```env
CONTRACT_ID=CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
PROGRESS_CONTRACT_ID=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
# REGISTER_CONTRACT_ID, SUBSCRIPTION_CONTRACT_ID, CONNECTION_CONTRACT_ID not set
# → registration uses CONTRACT_ID (CAAA...)
# → progress uses PROGRESS_CONTRACT_ID (CCCC...)
# → subscriptions use CONTRACT_ID (CAAA...)
# → connections use CONTRACT_ID (CAAA...)
```

## Multi-Sig Admin Operations

High-value admin operations require M-of-N multi-signature approval. See [docs/admin-multisig.md](docs/admin-multisig.md) for full details on the multi-sig lifecycle, state machine, endpoints, and configuration.

Quick reference:

1. **Configure admin wallets**: Set `ADMIN_WALLETS` to a comma-separated list of Stellar addresses (e.g., `ADMIN_WALLETS=GABC123...,GDEF456...`)
2. **Set threshold**: Configure `ADMIN_THRESHOLD` to the minimum number of admin signatures required (e.g., `ADMIN_THRESHOLD=2`)
3. **Backward compatibility**: If `ADMIN_WALLETS` is not set, the system falls back to `ADMIN_WALLET` with threshold 1
4. **TTL for proposals**: Configure `ADMIN_ACTION_TTL_MS` to control how long pending approvals remain valid (default: 1 hour)
5. **Operations affected**:
   - `POST /api/admin/fees` (withdraw fees)
   - `POST /api/admin/contract/pause`
   - `POST /api/admin/contract/unpause`
   - Other high-value admin endpoints
6. **Single-signer immediate execution**: When `ADMIN_THRESHOLD=1`, operations execute immediately without multi-sig approval

## Database Migrations

The server auto-creates the SQLite database on first start using `db/001_initial.sql`.  
For schema changes, add a new numbered migration file (`db/002_*.sql`) and apply it before deploying:

```bash
sqlite3 scout-off.db < db/002_your_migration.sql
```

Always back up the database file before running migrations in production.

## Database Backups

The `scripts/backup-db.sh` script copies the SQLite file to a timestamped backup location.
It supports local paths, AWS S3, and Google Cloud Storage.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DB_PATH` | — | Path to the SQLite file (default: `scout-off.db`) |
| `BACKUP_DEST` | ✅ | Backup destination — local path, `s3://…`, or `gs://…` |

### One-off backup

```bash
# Local
DB_PATH=/data/scout-off.db BACKUP_DEST=/var/backups/scout-off npm run backup-db

# AWS S3 (requires aws CLI and credentials in environment)
DB_PATH=/data/scout-off.db BACKUP_DEST=s3://my-bucket/scout-off-backups npm run backup-db

# Google Cloud Storage (requires gsutil / gcloud SDK)
DB_PATH=/data/scout-off.db BACKUP_DEST=gs://my-bucket/scout-off-backups npm run backup-db

# Equivalent direct invocation
DB_PATH=/data/scout-off.db BACKUP_DEST=/var/backups/scout-off bash scripts/backup-db.sh
```

The script exits with code `1` and prints an error to stderr on any failure (file missing, CLI not found, copy error, or verification failure).

Every backup is verified immediately after creation:

1. The script captures row counts for `players`, `events`, and `migrations` from the live database.
2. It writes a `.counts` sidecar file alongside the backup (same destination prefix).
3. It runs `scripts/verify-backup.sh`, which copies the backup to a scratch directory, runs `PRAGMA integrity_check`, and confirms the key table row counts match the sidecar.

Requires the `sqlite3` CLI on the host running backups (`python3` is used as a fallback when `sqlite3` is unavailable).

### Restore-verification drills

Run periodic drills against historical backups to confirm they remain restorable. Use `--verify-only` (delegates to `scripts/verify-backup.sh`) or call the verifier directly:

```bash
# Local backup + sidecar created at backup time
npm run backup-db -- --verify-only /var/backups/scout-off/scout-off-20250720T120000Z.db

# S3 (downloads backup and .counts sidecar automatically)
npm run backup-db -- --verify-only s3://my-bucket/scout-off-backups/scout-off-20250720T120000Z.db

# GCS
npm run backup-db -- --verify-only gs://my-bucket/scout-off-backups/scout-off-20250720T120000Z.db

# Direct verifier with explicit expected counts (e.g. if the sidecar was lost)
EXPECT_PLAYERS=120 EXPECT_EVENTS=5400 EXPECT_MIGRATIONS=18 \
  npm run verify-backup -- /var/backups/scout-off/scout-off-20250720T120000Z.db

# Equivalent direct invocations
bash scripts/backup-db.sh --verify-only /var/backups/scout-off/scout-off-20250720T120000Z.db
EXPECT_PLAYERS=120 EXPECT_EVENTS=5400 EXPECT_MIGRATIONS=18 \
  bash scripts/verify-backup.sh /var/backups/scout-off/scout-off-20250720T120000Z.db
```

Suggested schedule: weekly verification of the most recent backup, plus a monthly spot-check of a random older backup. Failed verification exits non-zero — wire alerts to your cron/systemd log monitoring the same way as backup failures.

Example weekly cron (`/etc/cron.d/scout-off-backup-verify`):

```cron
0 3 * * 0 ubuntu LATEST=$(aws s3 ls s3://my-bucket/scout-off-backups/ | awk '/\.db$/ { print $4 }' | sort | tail -1) && \
  bash /opt/scout-off/scripts/backup-db.sh --verify-only "s3://my-bucket/scout-off-backups/${LATEST}" >> /var/log/scout-off-backup-verify.log 2>&1
```

### Scheduling via cron

Add an entry to `/etc/cron.d/scout-off-backup` (runs hourly):

```cron
0 * * * * ubuntu DB_PATH=/data/scout-off.db BACKUP_DEST=s3://my-bucket/scout-off-backups bash /opt/scout-off/scripts/backup-db.sh >> /var/log/scout-off-backup.log 2>&1
```

Or as a systemd timer (`/etc/systemd/system/scout-off-backup.timer`):

```ini
[Unit]
Description=ScoutOff database backup

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

With a companion service (`/etc/systemd/system/scout-off-backup.service`):

```ini
[Unit]
Description=ScoutOff database backup

[Service]
Type=oneshot
EnvironmentFile=/etc/scout-off.env
ExecStart=/bin/bash /opt/scout-off/scripts/backup-db.sh
```

Enable with:

```bash
systemctl enable --now scout-off-backup.timer
```

### Backup retention

The script does not manage retention. Use your cloud provider's lifecycle policies or a tool like `find` for local pruning:

```bash
# Delete local backups older than 7 days
find /var/backups/scout-off -name '*.db' -mtime +7 -delete
```

For S3, configure an [Object Lifecycle rule](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) to expire objects after your desired retention window.

## Rate Limiting

For detailed documentation on rate limiting configuration, behavior, and namespacing, see [docs/rate-limiting.md](docs/rate-limiting.md).

**Quick summary:**
- Per-IP rate limiting via in-memory store (configurable window and max requests)
- Per-wallet rate limiting for authenticated endpoints
- Separate auth endpoint limits for brute-force protection
- Fail-open on store error (prioritizes availability)

## Reindexing

For detailed documentation on reindexing workflows, status polling, and operational considerations, see [docs/reindexing.md](docs/reindexing.md).

**Quick summary:**
- Reindex by posting to `POST /api/admin/indexer/reindex` with `{ fromLedger: N }`
- Poll status via separate endpoint (exact URL TBD in docs/reindexing.md)
- Single reindex at a time (singleton guard enforced)
- Cursor is rewound on completion (see docs for implications)

## CI/CD Expectations

- CI runs on every push via `.github/workflows/ci.yml`
- Pipeline: `npm install` → `npm run build` → `npm test`
- Deploy only from a passing main branch build
- Set all required env vars as CI/CD secrets — never commit `.env`

## Health & Monitoring

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness check; includes Stellar RPC status |
| `GET /ready` | Readiness probe; checks IPFS connectivity |
| `GET /version` | Deployed package version and git commit SHA |

Configure your load balancer or orchestrator to poll `/health` every 30 seconds.  
Alert on consecutive failures (≥ 2) to catch Stellar RPC or IPFS outages early.

Recommended metrics to track:
- HTTP 5xx error rate
- Event indexer lag (gap between latest on-chain event and last indexed event)
- SQLite file size growth

## Smoke Tests After Deployment

Run these checks immediately after every deployment:

1. `GET /health` → `{ "status": "ok" }`
2. `GET /ready` → `{ "status": "ok" }`
3. `GET /api/players` → returns array (may be empty)
4. `GET /auth/challenge?account=<any_valid_G_address>` → returns XDR challenge
5. `GET /api/admin/fees` with a valid admin JWT → returns fee history array

If any check fails, roll back to the previous build immediately.

## Release Process

1. Merge feature branch to `main` after PR review and CI green
2. Tag the release: `git tag v<semver> && git push --tags`
3. Build the Docker image (or run `npm run build` on the target server)
4. Apply any pending DB migrations
5. Restart the server process / redeploy the container
6. Run smoke tests (see above)
7. Monitor logs for 10 minutes post-deploy
