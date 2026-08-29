import { server } from './stellar';
import config from '../config';
import {
  getDb,
  getLastLedger,
  setLastLedger,
  upsertPlayer,
  updatePlayerProgress,
  getEvents,
  pruneWebhookDeliveries,
} from '../db';
import { dispatchEventWebhook } from './webhooks';
import { logger } from '../utils/logger';
import { tierForApprovedMilestones } from './tierPromotion';

/** Current indexer lag in ledgers (latestChainLedger - lastIndexedLedger). Reset after each poll. */
export let indexerLedgerLag = 0;

/** Threshold in ledgers above which a warning is logged. Configurable via INDEXER_LAG_WARN_THRESHOLD. */
function getLagWarnThreshold(): number {
  return parseInt(process.env.INDEXER_LAG_WARN_THRESHOLD ?? '100', 10);
}

// ─── Payload normalisation ────────────────────────────────────────────────────
//
// The Soroban contract emits events with snake_case field names but some events
// arrive with camelCase keys. normalizePayload() converts every camelCase key to
// snake_case on ingest so all DB reads can use a single canonical naming style.

function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/** Convert every camelCase key in a payload to snake_case. */
export function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [camelToSnake(k), v])
  );
}

// ─── Deduplication strategy ───────────────────────────────────────────────────
//
// Primary deduplication: the `events` table has a UNIQUE constraint on `tx_hash`.
// INSERT OR IGNORE silently discards any row whose tx_hash already exists, so
// replaying the same ledger range is safe and idempotent.
//
// Canonical event ID: each event is identified by the tuple
//   (contractId, ledger, txHash, topicIndex)
// normalizeEventId() encodes this as a single opaque string that can be used
// for in-memory dedup checks before hitting the DB (e.g. in tests or caches).
//
// Stub hooks (onBeforeInsert / onAfterInsert) are called around every insert so
// future logic (metrics, alerting, secondary caches) can be added without
// touching the core indexing loop.

/**
 * Returns a canonical, stable ID for a contract event.
 * Format: `<contractId>:<ledger>:<txHash>`
 */
export function normalizeEventId(contractId: string, ledger: number, txHash: string): string {
  return `${contractId}:${ledger}:${txHash}`;
}

// Stub hook — replace with real logic as needed (e.g. metrics, alerting).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onBeforeInsert(_eventId: string): void { /* hook */ }

// Stub hook — called after a successful insert (INSERT OR IGNORE may be a no-op).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onAfterInsert(_eventId: string): void { /* hook */ }

// ─── Indexer ──────────────────────────────────────────────────────────────────

export async function indexEvents(): Promise<void> {
  const db = getDb();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload) VALUES (?, ?, ?, ?)'
  );

  const fromLedger = getLastLedger();

  const response = await server.getEvents({
    startLedger: fromLedger || undefined,
    filters: [{ type: 'contract', contractIds: [config.contractId] }],
  });

  const lagAfterPoll = Math.max(0, response.latestLedger - (fromLedger > 0 ? fromLedger - 1 : response.latestLedger));
  indexerLedgerLag = lagAfterPoll;
  const threshold = getLagWarnThreshold();
  if (lagAfterPoll > threshold) {
    logger.warn(`[indexer] ledger lag=${lagAfterPoll} exceeds threshold=${threshold}`);
  }

  if (!response.events.length) return;

  const webhookEvents: Array<{ type: string; payload: unknown }> = [];

  const insertMany = db.transaction((events: typeof response.events) => {
    for (const raw of events) {
      const type = raw.topic[0]?.value() as string;
      const payload = normalizePayload((raw.value?.value() as unknown as Record<string, unknown>) ?? {});
      const eventId = normalizeEventId(config.contractId, raw.ledger, raw.txHash);
      onBeforeInsert(eventId);
      insert.run(type, raw.ledger, raw.txHash, JSON.stringify(payload));
      onAfterInsert(eventId);

      if (type === 'milestone_approved') {
        approvedMilestones.push({ type, payload });
      }

      if (type === 'player_registered') {
        upsertPlayer({
          player_id: payload.player_id as string,
          wallet: payload.wallet as string,
          position: payload.position as string | undefined,
          region: payload.region as string | undefined,
          metadata_uri: payload.metadata_uri as string | undefined,
          created_at: raw.ledger,
        });
      } else if (type === 'milestone_submitted') {
        // Insert into pending_milestones
        const milestoneId = payload.milestone_id as string;
        const playerId = payload.player_id as string;
        const validatorWallet = payload.validator as string;
        const milestoneType = payload.milestone_type as string;
        const evidenceUri = payload.evidence_uri as string;
        const submittedAt = raw.ledger;
        if (milestoneId && playerId && validatorWallet) {
          insertPendingMilestone(milestoneId, playerId, validatorWallet, milestoneType, evidenceUri, submittedAt);
        }
        webhookEvents.push({ type, payload });
      } else if (type === 'milestone_approved') {
        const playerId = payload.player_id as string;
        if (playerId) {
          // Tier promotion (#359): derive the player's tier from the total number
          // of approved milestones now recorded for them, rather than trusting a
          // progress_level field on the event payload. The just-inserted event is
          // already part of this count (same transaction), and replays are safe
          // because the events table dedups on tx_hash.
          const approvedMilestoneCount = getEvents('milestone_approved').filter(
            (e) => e.payload.player_id === playerId,
          ).length;
          updatePlayerProgress(playerId, tierForApprovedMilestones(approvedMilestoneCount));
        }
      }
    }
  });

  insertMany(response.events);

  for (const { type, payload } of webhookEvents) {
    dispatchEventWebhook(type, payload).catch((err: unknown) => {
      logger.warn(`[indexer] webhook dispatch failed for ${type}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const latest = response.events.at(-1)!;
  setLastLedger(latest.ledger + 1);
  indexerLedgerLag = Math.max(0, response.latestLedger - latest.ledger);

  // Prune webhook_deliveries rows older than 30 days on each poll cycle.
  // Runs in the background; failure is non-fatal.
  try {
    const pruned = pruneWebhookDeliveries();
    if (pruned > 0) {
      logger.debug(`[indexer] pruned ${pruned} webhook delivery records`);
    }
  } catch (err) {
    logger.warn(`[indexer] webhook delivery pruning failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
