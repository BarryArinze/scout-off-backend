// Set required env vars before any module is loaded in tests
process.env.CONTRACT_ID =
  process.env.CONTRACT_ID ??
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret";
// Use an in-memory SQLite database for all tests.
//
// WHY :memory:?
//   • Each test run starts with a clean, empty database — no leftover rows
//     from previous runs can cause tests to interfere with each other.
//   • Tests are fast: no disk I/O, no file locking, no cleanup needed.
//   • The database is automatically destroyed when the process exits.
//
// IMPORTANT: never override DB_PATH to a real file path in your local
// environment when running tests.  Pointing tests at scout-off.db (or any
// other persistent file) will mix test data with development data, produce
// non-deterministic results, and may corrupt your local database.
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

import { initDb } from "../src/db";
import { runMigrations } from "../src/db/migrate";

initDb();
// Ensure migrations are applied in tests (initDb() only creates base tables)
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires
runMigrations((global as any).__db ?? require("../src/db").getDb());
