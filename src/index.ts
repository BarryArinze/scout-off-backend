import { initTracing, shutdownTracing } from "./tracing";
initTracing();

import app from "./app";
import config from "./config";
import { logger } from "./utils/logger";
import { initDb, closeDb } from "./db";
import { stellarHealth } from "./services/stellar";
import { checkHealth } from "./services/ipfs";
import { indexEvents } from "./services/indexer";
import { getLastLedger, setLastLedger } from "./db";

// Database initialization is now async - must be awaited
async function start() {
  try {
    await initDb();
  } catch (err) {
    logger.error("Failed to initialize database:", err);
    process.exit(1);
  }

  // If INDEXER_BACKFILL_FROM_LEDGER is set and is less than the stored last_ledger,
  // reset last_ledger so the next poll replays from that point.
  if (config.backfillFromLedger !== null) {
    const stored = getLastLedger();
    if (config.backfillFromLedger < stored) {
      setLastLedger(config.backfillFromLedger);
      logger.info(
        `Backfill: reset last_ledger from ${stored} to ${config.backfillFromLedger}`,
      );
    }
  }

  await startServer();
}

async function startServer() {
  // Validate Pinata credentials at startup
  try {
    await checkHealth();
    logger.info("Pinata credential validation successful");
  } catch (err) {
    logger.error("Pinata credential validation failed at startup:", err);
    process.exit(1);
  }

  const server = app.listen(config.port, () => {
    logger.info(
      `ScoutOff backend running on port ${config.port} [${config.network}]`,
    );

    // Log startup health of critical dependencies
    (async () => {
      const statuses: Record<string, string> = { ipfs: "ok" };

      if (config.stellarHealthCheckEnabled) {
        try {
          const sOk = await stellarHealth();
          statuses.stellar = sOk ? "ok" : "unavailable";
        } catch {
          statuses.stellar = "unavailable";
        }
      } else {
        statuses.stellar = "disabled";
      }

      logger.info(`Startup health: ${JSON.stringify(statuses)}`);
    })();
  });

  // Poll for new contract events every 5 seconds
  const poll = async () => {
    try {
      await indexEvents();
    } catch (err) {
      logger.error("Indexer error:", (err as Error).message);
    }
  };

  poll();
  const pollInterval = setInterval(poll, 5_000);

  const SHUTDOWN_TIMEOUT_MS = 10_000;
  let isShuttingDown = false;

  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    const forceExitTimer = setTimeout(() => {
      logger.error(
        `Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    clearInterval(pollInterval);

    server.close(async (err) => {
      if (err) {
        logger.error("Error while closing HTTP server:", err);
      } else {
        logger.info("HTTP server closed, no longer accepting connections");
      }

      try {
        closeDb();
        logger.info("Database connection closed");
      } catch (dbErr) {
        logger.error("Error closing database:", dbErr);
      }

      try {
        await shutdownTracing();
        logger.info("Tracing SDK shut down");
      } catch (tracingErr) {
        logger.error("Error shutting down tracing:", tracingErr);
      }

      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  logger.error("Unhandled startup error:", err);
  process.exit(1);
});
