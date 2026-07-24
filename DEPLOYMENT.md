# Deployment Notes — ScoutOff Backend

## Environment Setup

Copy `.env.example` to `.env` and fill in all required values before starting the server.

> [!NOTE]
> For instructions and policies on managing, securing, and rotating long-lived secrets (such as JWT secrets, Pinata credentials, and platform signing keys), see the [Secrets Rotation Policy](docs/secrets-rotation.md).

| Variable | Required | Notes |
|---|---|---|
| `CONTRACT_ID` | ✅ | Deployed Soroban contract address |
| `JWT_SECRET` | ✅ | Min 32 chars; rotate on compromise |
| `HORIZON_URL` | ✅ | e.g. `https://horizon-testnet.stellar.org` |
| `SOROBAN_RPC_URL` | ✅ | e.g. `https://soroban-testnet.stellar.org` |
| `NETWORK` | ✅ | `testnet` or `mainnet` |
| `PINATA_API_KEY` / `PINATA_SECRET` | ✅ | IPFS upload credentials |
| `DB_DRIVER` | — | Database driver: `sqlite` (default) or `postgres` |
| `DB_PATH` | — | SQLite file path (default: `scout-off.db`); only used when `DB_DRIVER=sqlite` |
| `DATABASE_URL` | — (required when `DB_DRIVER=postgres`) | PostgreSQL connection string, e.g. `postgresql://user:pass@host:5432/db` |
| `SSE_KEEPALIVE_INTERVAL_MS` | — | Keep-alive ping interval for SSE connections, in ms (default: `15000`) |
| `SSE_MAX_CONNECTIONS` | — | Max concurrent SSE connections; `0` = unlimited (default: `0`) |
| `PORT` | — | API port (default: `4000`) |
| `LOG_LEVEL` | — | `debug` / `info` / `warn` / `error` |
| `LOG_SKIP_PATHS` | — | Comma-separated paths requestLogger silences (default: health + metrics probes) |
| `LOG_SAMPLE_RATE` | — | Float 0–1 sample rate for non-skipped paths (default: `1` = log all) |
| `STELLAR_HEALTH_CHECK_ENABLED` | — | Set `false` in staging to skip Stellar RPC check |
| `TRUSTED_PROXY_COUNT` | — | Number of trusted reverse proxies (default: `1`) |
| `ADMIN_WALLET` | — | Single admin wallet address (for backward compatibility) |
| `ADMIN_WALLETS` | — | Comma-separated list of admin wallet addresses (e.g., `GABC...,GDEF...`) |
| `ADMIN_THRESHOLD` | — | Number of admin signatures required for high-value operations (default: `1`) |
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated CORS allowed origins (defaults per env: `*` in dev, `https://staging.scoutoff.io` in staging, `https://app.scoutoff.io,https://scoutoff.io` in prod) |

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
DB_PATH=/data/scout-off.db BACKUP_DEST=/var/backups/scout-off bash scripts/backup-db.sh

# AWS S3 (requires aws CLI and credentials in environment)
DB_PATH=/data/scout-off.db BACKUP_DEST=s3://my-bucket/scout-off-backups bash scripts/backup-db.sh

# Google Cloud Storage (requires gsutil / gcloud SDK)
DB_PATH=/data/scout-off.db BACKUP_DEST=gs://my-bucket/scout-off-backups bash scripts/backup-db.sh
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
bash scripts/backup-db.sh --verify-only /var/backups/scout-off/scout-off-20250720T120000Z.db

# S3 (downloads backup and .counts sidecar automatically)
bash scripts/backup-db.sh --verify-only s3://my-bucket/scout-off-backups/scout-off-20250720T120000Z.db

# GCS
bash scripts/backup-db.sh --verify-only gs://my-bucket/scout-off-backups/scout-off-20250720T120000Z.db

# Direct verifier with explicit expected counts (e.g. if the sidecar was lost)
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

## Multi-Sig Admin Operations

High-value admin operations (withdraw fees, pause/unpause contract) require M-of-N multi-signature approval:

1. **Configure admin wallets**: Set `ADMIN_WALLETS` to a comma-separated list of Stellar addresses (e.g., `ADMIN_WALLETS=GABC123...,GDEF456...`)
2. **Set threshold**: Configure `ADMIN_THRESHOLD` to the minimum number of admin signatures required (e.g., `ADMIN_THRESHOLD=2`)
3. **Backward compatibility**: If `ADMIN_WALLETS` is not set, the system falls back to `ADMIN_WALLET` with threshold 1
4. **Operations affected**:
   - `POST /api/admin/fees` (withdraw fees)
   - `POST /api/admin/contract/pause`
   - `POST /api/admin/contract/unpause`
5. **Single-signer attempts**: When threshold > 1, single-admin attempts return 403 with "High-value operation requires multiple admin signatures"

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
