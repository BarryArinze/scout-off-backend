import { server } from './stellar';
import config from '../config';
import {
  getDb,
  getDriver,
  fetchLastIndexedLedger,
  persistLastIndexedLedger,
  insertOrUpdatePlayer,
  updatePlayerProgress,
  queryEvents,
  insertPendingMilestone,
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
    'INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  const fromLedger = fetchLastIndexedLedger();

  const response = await server.queryEvents({
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

  // NOTE: this used to be a single synchronous db.transaction() wrapping the
  // whole batch. insertOrUpdatePlayer/insertPendingMilestone/updatePlayerProgress
  // now go through the async DbDriver (required to support DB_DRIVER=postgres),
  // so they can no longer run inside a synchronous better-sqlite3 transaction
  // callback. The events table insert itself (the piece owned by the
  // event-indexing subsystem) still goes through the raw synchronous getDb()
  // handle unchanged. Losing whole-batch atomicity here is safe: every insert
  // below is idempotent (events dedup on tx_hash via INSERT OR IGNORE,
  // player/milestone upserts are keyed and re-appliable), so a mid-batch
  // failure just gets safely reprocessed on the next poll from the same
  // fromLedger.
  const insertMany = async (events: typeof response.events) => {
    for (const raw of events) {
      const type = raw.topic[0]?.value() as string;
      const payload = normalizePayload((raw.value?.value() as unknown as Record<string, unknown>) ?? {});
      const eventId = normalizeEventId(config.contractId, raw.ledger, raw.txHash);
      // Use ledger close time when available (seconds → ms), otherwise index time.
      const createdAt = raw.ledgerClosedAt
        ? new Date(raw.ledgerClosedAt).getTime()
        : Date.now();
      onBeforeInsert(eventId);
      insert.run(type, raw.ledger, raw.txHash, JSON.stringify(payload), createdAt);
      onAfterInsert(eventId);

      if (type === 'player_registered') {
        await insertOrUpdatePlayer({
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
          await insertPendingMilestone(milestoneId, playerId, validatorWallet, milestoneType, evidenceUri, submittedAt);
        }
        webhookEvents.push({ type, payload });
      } else if (type === 'milestone_approved') {
        const playerId = payload.player_id as string;
        if (playerId) {
          // Tier promotion (#359): derive the player's tier from the total number
          // of approved milestones now recorded for them, rather than trusting a
          // progress_level field on the event payload. The just-inserted event is
          // already part of this count, and replays are safe because the events
          // table dedups on tx_hash.
          const approvedMilestoneCount = queryEvents('milestone_approved').filter(
            (e) => e.payload.player_id === playerId,
          ).length;
          await updatePlayerProgress(playerId, tierForApprovedMilestones(approvedMilestoneCount));
        }
        webhookEvents.push({ type, payload });
      }
    }
  };

  await insertMany(response.events);

  for (const { type, payload } of webhookEvents) {
    dispatchEventWebhook(type, payload).catch((err: unknown) => {
      logger.warn(`[indexer] webhook dispatch failed for ${type}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const latest = response.events.at(-1)!;
  persistLastIndexedLedger(latest.ledger + 1);
  indexerLedgerLag = Math.max(0, response.latestLedger - latest.ledger);
}

// ─── Trial offer event log (#285) ──────────────────────────────────────────────

export interface TrialOfferEventRow {
  scout_wallet: string;
  player_id: string;
  details_uri: string;
  tx_hash: string;
  created_at: number;
}

/**
 * Persist an on-chain trial offer submission. Deduped by tx_hash (ON
 * CONFLICT DO NOTHING) so replaying the same on-chain event never creates
 * duplicate rows.
 */
export async function insertTrialOffer(
  scoutWallet: string,
  playerId: string,
  detailsUri: string,
  txHash: string,
  createdAt: number,
): Promise<void> {
  await getDriver().run(
    `INSERT INTO trial_offer_events (scout_wallet, player_id, details_uri, tx_hash, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (tx_hash) DO NOTHING`,
    [scoutWallet, playerId, detailsUri, txHash, createdAt],
  );
}

/** Return all trial offer events for a scout wallet, most recent first. */
export async function getTrialOffers(scoutWallet: string): Promise<TrialOfferEventRow[]> {
  return getDriver().all<TrialOfferEventRow>(
    `SELECT scout_wallet, player_id, details_uri, tx_hash, created_at
     FROM trial_offer_events WHERE scout_wallet = ? ORDER BY created_at DESC`,
    [scoutWallet],
  );
}

// ─── Validator registry helpers ───────────────────────────────────────────────

export interface ValidatorRow {
  wallet: string;
  registered_at: number;
  revoked_at: number | null;
  tx_hash: string | null;
}

/**
 * Insert a newly registered validator into the local DB.
 * Uses ON CONFLICT DO UPDATE so a re-registration after revocation resets
 * the row (equivalent to the old INSERT OR REPLACE, but portable — REPLACE
 * is SQLite-only syntax).
 */
export async function insertValidator(wallet: string, txHash?: string): Promise<void> {
  await getDriver().run(
    `INSERT INTO validators (wallet, registered_at, revoked_at, tx_hash)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT (wallet) DO UPDATE SET
       registered_at = excluded.registered_at,
       revoked_at = NULL,
       tx_hash = excluded.tx_hash`,
    [wallet, Math.floor(Date.now() / 1000), txHash ?? null],
  );
}

/**
 * Mark an existing validator as revoked by setting revoked_at.
 * No-op if the wallet is not found.
 */
export async function revokeValidatorRow(wallet: string, txHash?: string): Promise<void> {
  await getDriver().run(
    `UPDATE validators SET revoked_at = ?, tx_hash = ? WHERE wallet = ?`,
    [Math.floor(Date.now() / 1000), txHash ?? null, wallet],
  );
}

/**
 * Return all validator rows ordered by registration time descending.
 */
export async function getAllValidators(): Promise<ValidatorRow[]> {
  return getDriver().all<ValidatorRow>(
    `SELECT wallet, registered_at, revoked_at, tx_hash FROM validators ORDER BY registered_at DESC`,
  );
}

/**
 * Return a single validator row by wallet address, or null if not found.
 */
export async function getValidatorByWallet(wallet: string): Promise<ValidatorRow | null> {
  return (
    (await getDriver().get<ValidatorRow>(
      `SELECT wallet, registered_at, revoked_at, tx_hash FROM validators WHERE wallet = ?`,
      [wallet],
    )) ?? null
  );
}

