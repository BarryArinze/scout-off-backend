/**
 * reindexService.ts
 *
 * Robust event backfill system that replays Soroban contract events for a
 * specific ledger range, with:
 *   - Batched fetching (100 ledgers/batch, 50 ms inter-batch delay)
 *   - Duplicate-safe insertion via UNIQUE(tx_hash, event_index)
 *   - Deterministic ordering via eventOrdering (#1111)
 *   - Live progress tracking exposed through getReindexStatus()
 *   - Audit log entries for reindex_started and reindex_completed
 *
 * Design notes:
 *   • Only one reindex job may run at a time (singleton guard).
 *   • The job runs in the background (fire-and-forget); callers poll status.
 *   • normalizePayload / normalizeEventId from indexer.ts are reused so
 *     deduplication semantics are identical to the normal polling loop.
 */

import { server } from './stellar';
import { scValToNative } from '@stellar/stellar-sdk';
import config from '../config';
import { getDb, persistLastIndexedLedger } from '../db';
import { normalizePayload, normalizeEventId } from './indexer';
import { normalizeAndSortEvents, type RawIndexerEvent } from './eventOrdering';
import { logAuditEvent } from './audit';
import { logger } from '../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Ledger range limit enforced at the API layer (10 000). */
export const MAX_REINDEX_RANGE = 10_000;

/** How many ledgers to request per RPC batch. */
const BATCH_SIZE = 100;

/** Milliseconds to wait between batches (avoids RPC rate-limit). */
const BATCH_DELAY_MS = 50;

// ── Status ────────────────────────────────────────────────────────────────────

export type ReindexStatus = 'idle' | 'running' | 'complete' | 'error';

export interface ReindexState {
  status: ReindexStatus;
  fromLedger: number;
  toLedger: number;
  ledgersProcessed: number;
  ledgersTotal: number;
  eventsInserted: number;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

const initialState = (): ReindexState => ({
  status: 'idle',
  fromLedger: 0,
  toLedger: 0,
  ledgersProcessed: 0,
  ledgersTotal: 0,
  eventsInserted: 0,
  startedAt: null,
  completedAt: null,
  errorMessage: null,
});

let _state: ReindexState = initialState();

/** Return a read-only snapshot of the current reindex state. */
export function getReindexStatus(): Readonly<ReindexState> {
  return { ..._state };
}

/** Reset state — used in tests only. */
export function _resetReindexState(): void {
  _state = initialState();
}

// ── Core background job ───────────────────────────────────────────────────────

/**
 * Start a background reindex job for the ledger range [fromLedger, toLedger].
 *
 * Returns immediately. Callers poll `getReindexStatus()` for progress.
 * Throws synchronously if a job is already running (caller must check status
 * before calling).
 *
 * @param fromLedger - First ledger to replay (inclusive).
 * @param toLedger   - Last ledger to replay (inclusive).
 * @param adminWallet - Wallet of the admin who triggered the reindex (for audit).
 */
export function startReindex(
  fromLedger: number,
  toLedger: number,
  adminWallet: string,
): void {
  if (_state.status === 'running') {
    throw new ReindexAlreadyRunningError('A reindex job is already in progress.');
  }

  _state = {
    status: 'running',
    fromLedger,
    toLedger,
    ledgersProcessed: 0,
    ledgersTotal: toLedger - fromLedger + 1,
    eventsInserted: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    errorMessage: null,
  };

  logAuditEvent({
    action: 'reindex_started',
    adminWallet,
    queryParams: { fromLedger, toLedger },
    timestamp: _state.startedAt!,
  }).catch(() => {});

  logger.info(`[reindex] started fromLedger=${fromLedger} toLedger=${toLedger} admin=${adminWallet}`);

  // Fire-and-forget — errors are caught inside _runReindex.
  _runReindex(fromLedger, toLedger, adminWallet).catch((err: unknown) => {
    logger.error(`[reindex] unexpected error in background job: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _runReindex(
  fromLedger: number,
  toLedger: number,
  adminWallet: string,
): Promise<void> {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events
      (type, ledger, tx_hash, payload, created_at, tx_application_order, event_index, contract_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let eventsInserted = 0;
  let currentBatchStart = fromLedger;

  try {
    while (currentBatchStart <= toLedger) {
      const batchEnd = Math.min(currentBatchStart + BATCH_SIZE - 1, toLedger);

      let batchEvents: Awaited<ReturnType<typeof server.getEvents>>['events'] = [];
      try {
        const response = await server.getEvents({
          startLedger: currentBatchStart,
          filters: [{ type: 'contract', contractIds: [config.registerContractId] }],
        });
        batchEvents = response.events.filter(
          (e: (typeof response.events)[number]) => e.ledger >= currentBatchStart && e.ledger <= batchEnd,
        );
      } catch (rpcErr: unknown) {
        logger.warn(
          `[reindex] RPC error on ledger batch ${currentBatchStart}-${batchEnd}: ${
            rpcErr instanceof Error ? rpcErr.message : String(rpcErr)
          }`,
        );
        // Continue to next batch — partial failures don't abort the job.
      }

      const rawEvents: RawIndexerEvent[] = batchEvents.map((raw: any) => ({
        ledger: raw.ledger,
        txHash: raw.txHash,
        id: raw.id,
        contractId: raw.contractId ?? config.registerContractId,
        topic: raw.topic,
        value: raw.value,
        ledgerClosedAt: raw.ledgerClosedAt,
        txIndex: raw.txIndex,
        eventIndex: raw.eventIndex,
      }));
      const ordered = normalizeAndSortEvents(rawEvents, config.registerContractId);

      // Insert events from this batch in a single transaction, in total order.
      const insertBatch = db.transaction(
        (events: typeof ordered) => {
          let batchInserted = 0;
          for (const event of events) {
            const raw = event.raw as any;
            const type = raw.topic?.[0] ? (scValToNative(raw.topic[0]) as string) : '';
            const payload = normalizePayload(
              (raw.value ? (scValToNative(raw.value) as Record<string, unknown>) : {}) ?? {},
            );
            const eventId = normalizeEventId(
              event.contractId,
              event.ledger,
              event.txHash,
              event.eventIndex,
            );
            const createdAt = raw.ledgerClosedAt
              ? new Date(raw.ledgerClosedAt).getTime()
              : Date.now();

            const result = insert.run(
              type,
              event.ledger,
              event.txHash,
              JSON.stringify(payload),
              createdAt,
              event.txApplicationOrder,
              event.eventIndex,
              event.contractId,
            );
            if (result.changes === 1) {
              batchInserted++;
              logger.debug(`[reindex] inserted eventId=${eventId}`);
            }
          }
          return batchInserted;
        },
      );

      eventsInserted += insertBatch(ordered);

      const ledgersProcessed = batchEnd - fromLedger + 1;
      _state = {
        ..._state,
        ledgersProcessed,
        eventsInserted,
      };

      logger.info(
        `[reindex] batch done ledgers=${currentBatchStart}-${batchEnd} eventsInserted=${eventsInserted} total`,
      );

      currentBatchStart = batchEnd + 1;

      // Throttle: wait between batches to avoid overwhelming the RPC.
      if (currentBatchStart <= toLedger) {
        await _delay(BATCH_DELAY_MS);
      }
    }

    // Update the indexer's last_ledger so the normal poll loop resumes from
    // the correct position after the reindex completes.
    persistLastIndexedLedger(toLedger + 1);

    const completedAt = new Date().toISOString();
    _state = {
      ..._state,
      status: 'complete',
      ledgersProcessed: _state.ledgersTotal,
      completedAt,
      errorMessage: null,
    };

    logAuditEvent({
      action: 'reindex_completed',
      adminWallet,
      queryParams: { fromLedger, toLedger, eventsInserted },
      timestamp: completedAt,
    }).catch(() => {});

    logger.info(
      `[reindex] completed fromLedger=${fromLedger} toLedger=${toLedger} eventsInserted=${eventsInserted}`,
    );
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    _state = {
      ..._state,
      status: 'error',
      completedAt: new Date().toISOString(),
      errorMessage,
    };

    logAuditEvent({
      action: 'reindex_error',
      adminWallet,
      queryParams: { fromLedger, toLedger, error: errorMessage },
      timestamp: new Date().toISOString(),
    }).catch(() => {});

    logger.error(`[reindex] failed: ${errorMessage}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class ReindexAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReindexAlreadyRunningError';
  }
}
