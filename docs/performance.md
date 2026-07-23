# Performance Budget

This document defines target performance budgets for ScoutOff's most latency-sensitive API endpoints. Budgets are derived from a baseline run against the current implementation; they should be revisited when significant architectural changes land (e.g., a Redis cache layer, database migrations, or Soroban contract modifications).

## Budgets

All measurements are taken against a locally-running instance (single Node.js process, SQLite on disk) using the `scripts/loadtest.ts` autocannon harness.

| Endpoint | p50 | p95 | p99 | Throughput (req/s) |
|---|---|---|---|---|
| `GET /api/players` | ≤ 50 ms | ≤ 150 ms | ≤ 300 ms | ≥ 200 |
| `GET /api/players/:playerId` | ≤ 30 ms | ≤ 100 ms | ≤ 200 ms | ≥ 500 |
| `POST /auth/token` | ≤ 100 ms | ≤ 300 ms | ≤ 500 ms | ≥ 100 |

These budgets assume:

- Seeded dataset of at least 5 players (the default from `scripts/seed.ts`)
- No concurrent long-running Soroban RPC calls (the auth endpoint has no Stellar dependency; player detail reads from SQLite and cache)
- Server running on a modern laptop or CI-equivalent runner

## Running the Load Test

### 1. Seed the database

```bash
npx ts-node --project tsconfig.scripts.json scripts/seed.ts
```

### 2. Start the server

```bash
npm start
```

The server listens on `http://localhost:4000` by default (configurable via `PORT`).

### 3. Run the load test

```bash
npm run loadtest
```

This runs `autocannon` against the three endpoints sequentially, each for 30 seconds with 20 concurrent connections.

### Configuration

| Env var | Default | Description |
|---|---|---|
| `LOADTEST_TARGET` | `http://localhost:4000` | Base URL of the running server |
| `LOADTEST_DURATION_SEC` | `30` | Seconds each endpoint is exercised |
| `LOADTEST_CONNECTIONS` | `20` | Number of concurrent connections |
| `LOADTEST_PLAYER_ID` | `seed-player-001` | Player id used for detail endpoint |

## CI

The load test is **not** wired into the standard per-PR CI pipeline. It is intended for manual runs before performance-sensitive releases. If a future CI runner is provisioned with adequate resources, the budgets above can be enforced by adding a step that fails if any metric exceeds the target.

## Baseline

> **Status: baseline not yet recorded — tracked in [issue #720](https://github.com/scout-off/scout-off-backend/issues/720).**
>
> The table below has placeholder values.  The first contributor to run a reproducible
> load-test against `main` should fill in the numbers and open a follow-up PR to lock
> them in.  Instructions for producing and recording a baseline are in the
> [Running the Load Test](#running-the-load-test) section above.

A baseline run has not yet been conducted.  To record one:

1. Check out the commit you want to baseline:
   ```bash
   git checkout main   # or a specific SHA
   ```
2. Seed and start the server:
   ```bash
   npm run seed
   npm start
   ```
3. Run the load test and capture stdout:
   ```bash
   npm run loadtest 2>&1 | tee loadtest-baseline.txt
   ```
4. Fill in the table below with the results, the date, and the exact commit SHA.
5. Open a PR updating this file — include the `loadtest-baseline.txt` output as a PR comment
   for reproducibility.

| Endpoint | p50 | p95 | p99 | Throughput | Recorded on | Commit |
|---|---|---|---|---|---|---|
| `GET /api/players` | — | — | — | — | *(not yet recorded)* | *(not yet recorded)* |
| `GET /api/players/:playerId` | — | — | — | — | *(not yet recorded)* | *(not yet recorded)* |
| `POST /auth/token` | — | — | — | — | *(not yet recorded)* | *(not yet recorded)* |

**Command used to produce these results** *(fill in when recording)*:
```bash
# Example — replace <SHA> and <DATE> with real values
# git checkout <SHA>
# npm run seed && npm start &
# DATABASE_SSL=false npm run loadtest
```

*Environment* *(fill in when recording)*: Node vX.Y.Z, SQLite on SSD, single-process, no Redis.
