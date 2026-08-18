# Deployment Notes — ScoutOff Backend

## Environment Setup

Copy `.env.example` to `.env` and fill in all required values before starting the server.

> [!NOTE]
> For instructions and policies on managing, securing, and rotating long-lived secrets (such as JWT secrets, Pinata credentials, and platform signing keys), see the [Secrets Rotation Policy](docs/secrets-rotation.md).

| Variable | Required | Notes |
|---|---|---|
| `CONTRACT_ID` | — | Legacy single-contract address (backward compat). Falls back as default for each per-contract var below. |
| `REGISTER_CONTRACT_ID` | ✅ | Deployed `register` Soroban contract address |
| `PROGRESS_CONTRACT_ID` | ✅ | Deployed `progress` Soroban contract address |
| `SUBSCRIPTION_CONTRACT_ID` | ✅ | Deployed `subscription` Soroban contract address |
| `CONNECTION_CONTRACT_ID` | ✅ | Deployed `connection` Soroban contract address |
| `JWT_SECRET` | ✅ | Min 32 chars; rotate via dual-key window (see below) |
| `JWT_SECRET_PREVIOUS` | — | Previous signing secret during rotation grace window |
| `JWT_SECRET_PREVIOUS_UNTIL` | — | Absolute grace-window end (Unix seconds or ISO-8601). After this time previous tokens are rejected even if `JWT_SECRET_PREVIOUS` is still set |
| `SEP10_SERVER_SECRET` | ✅ | Stellar secret key (starts with `S`) used to sign and verify SEP-10 challenge transactions. **Must be identical across every backend instance** — without it each process generates an ephemeral random keypair, causing cross-instance auth failures under a load balancer. Generate with `stellar keys generate` and store in your secrets manager. See [docs/auth.md](docs/auth.md#sep-10-server-keypair-sep10_server_secret) for rotation guidance. |
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
| `STELLAR_HEALTH_CHECK` | — | Set `false` in staging to skip Stellar RPC check |
| `TRUSTED_PROXY_COUNT` | — | Number of trusted reverse proxies (default: `1`). Set to the exact number of proxy hops between the internet and this server. **Fail-safe**: if the observed `X-Forwarded-For` chain has fewer entries than this value implies, `extractClientIp()` falls back to the raw socket address rather than trusting the attacker-controlled leftmost value. A chain shorter than expected (direct connection bypassing a proxy, or a client crafting a short header) will therefore appear to come from the connecting IP, not a spoofed address. |
| `ADMIN_WALLET` | — | Single admin wallet address (for backward compatibility) |
| `ADMIN_WALLETS` | — | Comma-separated list of admin wallet addresses (e.g., `GABC...,GDEF...`) |
| `ADMIN_THRESHOLD` | — | Number of admin signatures required for high-value operations (default: `1`) |
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated CORS allowed origins (defaults per env: `*` in dev, `https://staging.scoutoff.io` in staging, `https://app.scoutoff.io,https://scoutoff.io` in prod) |
| `ADMIN_IP_ALLOWLIST` | — | Comma-separated list of **IPv4** addresses/CIDR ranges allowed to reach admin endpoints (e.g. `192.168.1.0/24,10.0.0.1`). Unset/empty disables the check. IPv6 is not supported yet — any IPv6 client IP is rejected with 403 regardless of this setting (fail closed). |

---

## Multi-Contract Architecture

ScoutOff deploys five separate Soroban contracts, each with its own on-chain address:

| Contract | Env var | Purpose |
|---|---|---|
| `register` | `REGISTER_CONTRACT_ID` | Player profiles, progress levels |
| `progress` | `PROGRESS_CONTRACT_ID` | Milestone submission and approval |
| `subscription` | `SUBSCRIPTION_CONTRACT_ID` | Scout subscriptions, contact fees, fee balance |
| `connection` | `CONNECTION_CONTRACT_ID` | Scout-player connections, trial offers |
| `player_token` | _(not yet wired)_ | Player token contract (future) |

### Deploying the contracts

Deploy each crate to testnet (or mainnet), noting the resulting contract ID:

```bash
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/register.wasm \
  --source deployer --network testnet
# → REGISTER_CONTRACT_ID=CABC...

stellar contract deploy --wasm target/wasm32-unknown-unknown/release/progress.wasm \
  --source deployer --network testnet
# → PROGRESS_CONTRACT_ID=CDEF...

stellar contract deploy --wasm target/wasm32-unknown-unknown/release/subscription.wasm \
  --source deployer --network testnet
# → SUBSCRIPTION_CONTRACT_ID=CGHI...

stellar contract deploy --wasm target/wasm32-unknown-unknown/release/connection.wasm \
  --source deployer --network testnet
# → CONNECTION_CONTRACT_ID=CJKL...
```

### Initializing each contract

```bash
# register
stellar contract invoke --id $REGISTER_CONTRACT_ID --source admin --network testnet \
  -- initialize --admin $ADMIN_ADDR --token $TOKEN_ADDR --platform_fee_bps 500

# progress (needs register address so it can cross-call update_progress_level)
stellar contract invoke --id $PROGRESS_CONTRACT_ID --source admin --network testnet \
  -- initialize --admin $ADMIN_ADDR --register_contract $REGISTER_CONTRACT_ID

# subscription
stellar contract invoke --id $SUBSCRIPTION_CONTRACT_ID --source admin --network testnet \
  -- initialize --admin $ADMIN_ADDR --token $TOKEN_ADDR --platform_fee_bps 500

# connection (needs register + subscription addresses)
stellar contract invoke --id $CONNECTION_CONTRACT_ID --source admin --network testnet \
  -- initialize --admin $ADMIN_ADDR \
     --register_contract $REGISTER_CONTRACT_ID \
     --subscription_contract $SUBSCRIPTION_CONTRACT_ID
```

### Registering authorized updaters

Both `progress` and `connection` need permission to call `update_progress_level`
on the `register` contract. Register each using the new `add_authorized_updater`
entrypoint:

```bash
# Allow the progress contract to update player progress
stellar contract invoke --id $REGISTER_CONTRACT_ID --source admin --network testnet \
  -- add_authorized_updater --updater $PROGRESS_CONTRACT_ID

# Allow the connection contract to update player progress (for trial offers)
stellar contract invoke --id $REGISTER_CONTRACT_ID --source admin --network testnet \
  -- add_authorized_updater --updater $CONNECTION_CONTRACT_ID
```

Both addresses will coexist in the allowlist — adding the second does not evict
the first. Verify with:

```bash
stellar contract invoke --id $REGISTER_CONTRACT_ID --source any --network testnet \
  -- get_authorized_updaters
# → ["CDEF...", "CJKL..."]
```

### Pausing and unpausing

Each contract (`register`, `subscription`, `connection`) exposes `pause(admin)`
and `unpause(admin)` entrypoints that the backend routes to via the
`pauseContractOnChain` / `unpauseContractOnChain` helpers in `stellar.ts`.
The backend currently routes pause/unpause calls to the **subscription** contract.
To pause all user-facing operations, call `pause` on each contract individually
if needed.

```bash
stellar contract invoke --id $SUBSCRIPTION_CONTRACT_ID --source admin --network testnet \
  -- pause --admin $ADMIN_ADDR
```

### Backward compatibility

Single-contract deployments that set only `CONTRACT_ID` continue to work without
changes. Each per-contract env var falls back to `CONTRACT_ID` when unset,
preserving backward compatibility during staged migrations.


## Kubernetes / Helm Deployment

The `helm/scout-off-backend/` directory contains a production-grade Helm 3 chart
(API version `v2`) for deploying the backend to Kubernetes.

### Default topology: single-replica SQLite

The chart's defaults deploy a **single replica backed by SQLite**:
`replicaCount: 1`, `hpa.enabled: false`, `pdb.enabled: false`, and
`env.DB_DRIVER: sqlite`. This is the only topology that is internally
consistent out of the box — SQLite is a single-process, single-file database
with no support for concurrent access from multiple processes, so scaling to
multiple pods while on SQLite would give every pod its own unshared, ephemeral
database file (writes invisible across pods, data lost on restart).

To scale horizontally you **must** switch to PostgreSQL first:

```bash
helm upgrade --install scout-off-backend ./helm/scout-off-backend \
  --set env.DB_DRIVER=postgres \
  --set env.DATABASE_URL=postgresql://user:pass@host:5432/db \
  --set replicaCount=3 \
  --set hpa.enabled=true
```

See [docs/postgres-migration.md](docs/postgres-migration.md) for the migration
procedure. If you override the defaults into the broken combination
(SQLite + more than one replica, or SQLite + HPA enabled), the chart prints a
loud warning in its NOTES.txt output instead of silently deploying it; the
`scripts/validate-helm-chart.sh` CI check enforces this invariant on every
push.

### Prerequisites

- Helm 3.x installed (`helm version`)
- A Kubernetes cluster with `kubectl` configured
- The `scout-off-secrets` Kubernetes Secret created in the target namespace
  **before** the first `helm install` (see below)

### 1. Create the Kubernetes Secret

Sensitive env vars (`CONTRACT_ID`, `JWT_SECRET`, and optional rotation keys) are
sourced exclusively from a Kubernetes Secret — they are never stored in the
ConfigMap or committed to source control.

```bash
kubectl create secret generic scout-off-secrets \
  --from-literal=CONTRACT_ID=<your-soroban-contract-id> \
  --from-literal=JWT_SECRET=<min-32-char-random-string> \
  --from-literal=SEP10_SERVER_SECRET=<stellar-secret-key-starting-with-S> \
  --namespace <your-namespace>
```

> **Horizontal scaling note:** `SEP10_SERVER_SECRET` is the most important variable to
> get right in a multi-pod deployment. Every pod **must** receive the same value.
> If pods receive different keys (or any pod falls back to the ephemeral random
> key because the variable is absent), a challenge built by one pod will be
> rejected by any other pod — causing intermittent, hard-to-diagnose auth
> failures proportional to `(N-1)/N` where N is the replica count.
> Store the key in the Kubernetes Secret (as shown above) and reference it in
> the Deployment's `envFrom` / `env.valueFrom.secretKeyRef` block so all pods
> share the exact same value. See
> [docs/auth.md](docs/auth.md#sep-10-server-keypair-sep10_server_secret) for
> generation instructions and the safe rotation procedure.

### JWT secret rotation runbook (zero-downtime dual-key)

Do **not** hard-cutover `JWT_SECRET` alone — that instantly invalidates every
active access and refresh token. Use the dual-key window instead:

1. **Stage previous secret + grace deadline**
   ```bash
   # Capture the currently deployed secret, then create a new one
   OLD_JWT_SECRET=$(kubectl get secret scout-off-secrets -n <ns> -o jsonpath='{.data.JWT_SECRET}' | base64 -d)
   NEW_JWT_SECRET=$(openssl rand -hex 32)
   # Grace window must cover the longest-lived token (refresh TTL = 7 days)
   UNTIL=$(date -u -v+7d +%Y-%m-%dT%H:%M:%SZ)   # macOS; on Linux: date -u -d '+7 days' --iso-8601=seconds
   ```

2. **Apply both secrets and redeploy**
   ```bash
   kubectl create secret generic scout-off-secrets \
     --from-literal=CONTRACT_ID=<same-as-before> \
     --from-literal=JWT_SECRET="$NEW_JWT_SECRET" \
     --from-literal=JWT_SECRET_PREVIOUS="$OLD_JWT_SECRET" \
     --from-literal=JWT_SECRET_PREVIOUS_UNTIL="$UNTIL" \
     --from-literal=SEP10_SERVER_SECRET=<same-as-before> \
     --dry-run=client -o yaml | kubectl apply -f - --namespace <your-namespace>
   kubectl rollout restart deployment/scout-off-backend --namespace <your-namespace>
   ```
   New tokens are signed only with `JWT_SECRET`. Tokens signed with the old
   secret continue to verify until `JWT_SECRET_PREVIOUS_UNTIL`.

3. **After the grace window**
   Remove `JWT_SECRET_PREVIOUS` / `JWT_SECRET_PREVIOUS_UNTIL` from the Secret
   and roll out again. Compromised individual sessions should still be killed
   via the token blocklist (`tokenBlocklist`), not by rotating the secret.

For non-JWT secrets, rotate by deleting and re-creating the Secret, then
triggering a rollout:

```bash
kubectl delete secret scout-off-secrets --namespace <your-namespace>
kubectl create secret generic scout-off-secrets \
  --from-literal=CONTRACT_ID=<new-value> \
  --from-literal=JWT_SECRET=<new-value> \
  --namespace <your-namespace>
kubectl rollout restart deployment/scout-off-backend --namespace <your-namespace>
```

### 2. Install the chart

```bash
helm install scout-off-backend ./helm/scout-off-backend \
  --namespace <your-namespace> \
  --create-namespace \
  --set image.tag=<git-sha-or-semver>
```

### 3. Upgrade

```bash
helm upgrade scout-off-backend ./helm/scout-off-backend \
  --namespace <your-namespace> \
  --set image.tag=<new-tag>
```

### 4. Override values

Create a `my-values.yaml` file with any overrides and pass it with `-f`:

```bash
helm upgrade --install scout-off-backend ./helm/scout-off-backend \
  --namespace production \
  -f my-values.yaml \
  --set image.tag=v1.2.3
```

Common overrides:

| Key | Default | Description |
|-----|---------|-------------|
| `image.tag` | chart appVersion | Docker image tag to deploy |
| `replicaCount` | `1` | Pod count. Keep at `1` while `env.DB_DRIVER=sqlite` (SQLite is single-process); raise it only after switching to PostgreSQL |
| `hpa.enabled` | `false` | Enable autoscaling. Requires `env.DB_DRIVER=postgres` + `env.DATABASE_URL` |
| `hpa.maxReplicas` | `10` | Maximum pods under autoscaling (only when `hpa.enabled=true`) |
| `hpa.targetCPUUtilizationPercentage` | `70` | CPU threshold to trigger scale-up |
| `hpa.targetMemoryUtilizationPercentage` | `80` | Memory threshold to trigger scale-up |
| `pdb.enabled` | `false` | Enable a PodDisruptionBudget. Enable for multi-replica (PostgreSQL-backed) deployments |
| `ingress.enabled` | `false` | Expose the service via an Ingress |
| `ingress.hosts[0].host` | `api.scoutoff.io` | Public hostname |
| `ingress.tls[0].secretName` | `scout-off-tls` | TLS certificate Secret name |
| `resources.requests.cpu` | `100m` | CPU request |
| `resources.limits.cpu` | `500m` | CPU limit |
| `resources.requests.memory` | `256Mi` | Memory request |
| `resources.limits.memory` | `512Mi` | Memory limit |
| `secretName` | `scout-off-secrets` | Name of the Kubernetes Secret |
| `env.NODE_ENV` | `production` | Node environment |
| `env.DB_DRIVER` | `sqlite` | `sqlite` or `postgres` |

### 5. Lint the chart

```bash
helm lint helm/scout-off-backend
```

### 6. Render templates locally (dry-run)

```bash
helm template scout-off-backend ./helm/scout-off-backend \
  --set image.tag=local-test
```

This produces a Deployment, Service, ConfigMap, and (when `ingress.enabled=true`)
an Ingress resource. The HPA and PodDisruptionBudget are only rendered when
`hpa.enabled=true` / `pdb.enabled=true` respectively.

### 7. Uninstall

```bash
helm uninstall scout-off-backend --namespace <your-namespace>
```

> **Note:** Uninstalling the chart does **not** delete the `scout-off-secrets`
> Secret. Delete it manually if you are tearing down the environment entirely.

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

### Docker Compose Healthcheck

The `docker-compose.yml` configures a healthcheck on the backend service that polls `/health/liveness` every 10 seconds:

```yaml
healthcheck:
  test: ["CMD", "wget", "--spider", "-q", "http://localhost:4000/health/liveness"]
  interval: 10s
  timeout: 5s
  retries: 3
  start_period: 15s
```

Docker marks the container `(healthy)` once the first probe succeeds. The `start_period` of 15 seconds gives the Express server time to initialize before probes are counted as failures. The `--spider` flag tells `wget` to perform a HEAD-only request without downloading the response body, keeping healthcheck logs quiet. Run `docker compose ps` to confirm the container status shows `(healthy)` after startup.

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
5. The deploy script handles starting the new process and flipping traffic automatically.
6. Run smoke tests (see above) - this happens automatically in the staging pipeline.
7. Monitor logs for 10 minutes post-deploy

## Blue-Green Deployment Topology

Staging uses a local blue-green deployment strategy to eliminate restart downtime.

### Topology
- **Process Manager**: PM2 manages two identical Node.js services named `scout-off-backend-blue` (port 4000) and `scout-off-backend-green` (port 4001).
- **Reverse Proxy**: Nginx routes traffic to the active slot.
- **State**: The currently active slot is stored in a `.active-slot` file in the deployment root.

### Nginx Configuration Requirement
To support dynamic traffic flipping, Nginx must be configured to use a dedicated upstream config block located at `/etc/nginx/conf.d/scout-off-upstream.conf`.

1. Create the upstream config file:
   ```bash
   sudo touch /etc/nginx/conf.d/scout-off-upstream.conf
   sudo chmod 666 /etc/nginx/conf.d/scout-off-upstream.conf
   echo "upstream scout_off_backend { server 127.0.0.1:4000; }" > /etc/nginx/conf.d/scout-off-upstream.conf
   ```
2. In your main Nginx site config (e.g., `/etc/nginx/sites-available/scout-off`), use the upstream:
   ```nginx
   location / {
       proxy_pass http://scout_off_backend;
       # ... other proxy headers ...
   }
   ```

### Manual Override & Rollback
If you need to manually rollback traffic to the previously active slot:
```bash
# From the deployment root path:
bash scripts/deploy-staging.sh . rollback
```

To manually view the PM2 processes:
```bash
pm2 status
pm2 logs scout-off-backend-blue
pm2 logs scout-off-backend-green
```
