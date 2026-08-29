import { initTracing } from './tracing';
initTracing();

import app from './app';
import config from './config';
import { logger } from './utils/logger';
import { initDb } from './db';
import { stellarHealth } from './services/stellar';
import { checkHealth } from './services/ipfs';
import { indexEvents } from './services/indexer';
import { getLastLedger, setLastLedger } from './db';
import { bootstrapFeatureFlags } from './services/featureFlags';

initDb();
bootstrapFeatureFlags();

// If INDEXER_BACKFILL_FROM_LEDGER is set and is less than the stored last_ledger,
// reset last_ledger so the next poll replays from that point.
if (config.backfillFromLedger !== null) {
  const stored = getLastLedger();
  if (config.backfillFromLedger < stored) {
    setLastLedger(config.backfillFromLedger);
    logger.info(`Backfill: reset last_ledger from ${stored} to ${config.backfillFromLedger}`);
  }
}

async function startServer() {
  // Validate Pinata credentials at startup
  try {
    await checkHealth();
    logger.info('Pinata credential validation successful');
  } catch (err) {
    logger.error('Pinata credential validation failed at startup:', err);
    process.exit(1);
  }

  app.listen(config.port, () => {
    logger.info(`ScoutOff backend running on port ${config.port} [${config.network}]`);

    // Log startup health of critical dependencies
    (async () => {
      const statuses: Record<string, string> = { ipfs: 'ok' };

      if (config.stellarHealthCheckEnabled) {
        try {
          const sOk = await stellarHealth();
          statuses.stellar = sOk ? 'ok' : 'unavailable';
        } catch {
          statuses.stellar = 'unavailable';
        }
      } else {
        statuses.stellar = 'disabled';
      }

      logger.info(`Startup health: ${JSON.stringify(statuses)}`);
    })();

    // Poll for new contract events every 5 seconds
    const poll = async () => {
      try {
        await indexEvents();
      } catch (err) {
        logger.error('Indexer error:', (err as Error).message);
      }
    };

    poll();
    setInterval(poll, 5_000);
  });
}

startServer().catch(err => {
  logger.error('Unhandled startup error:', err);
  process.exit(1);
});
