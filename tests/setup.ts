// Set required env vars before any module is loaded in tests
process.env.CONTRACT_ID =
  process.env.CONTRACT_ID ??
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret";
process.env.DB_PATH = process.env.DB_PATH ?? ":memory:";
// Use port 0 so each test file's server instance binds to a random
// available port, preventing EADDRINUSE conflicts across test suites.
process.env.PORT = process.env.PORT ?? "0";
process.env.STELLAR_HEALTH_CHECK = "false";
// Default admin wallet for tests exercising admin-wallet-gated actions
// (pauseContract/unpauseContract/withdrawFeesController). Individual test
// files construct admin JWTs for this same wallet where needed. Must be set
// here (before src/config is first imported transitively via src/db below)
// since config.ts computes config.adminWallets once at module load time.
process.env.ADMIN_WALLET =
  process.env.ADMIN_WALLET ??
  "GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4";
// Deterministic 32-byte key for webhook secret encryption-at-rest (#686) so
// tests exercise the real AES-256-GCM path instead of the insecure dev-only
// fallback used when this var is unset outside production.
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY =
  process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ??
  "0".repeat(63) + "1";

import { initDb } from "../src/db";

initDb();
