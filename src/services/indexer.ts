import { server } from './stellar';
import config from '../config';
import {
  getDb,
  fetchLastIndexedLedger,
  persistLastIndexedLedger,
  insertOrUpdatePlayer,
  updatePlayerProgress,
  getEvents,
  insertPendingMilestone,
  queryEvents,
  rollbackEventsFromLedger,
} from '../db';
import { dispatchEventWebhook } from './webhooks';
import { logger } from '../utils/logger';
import { tierForApprovedMilestones } from './tierPromotion';

// Lazy import cache service to avoid circular dependency
function getCache() {
  return require('./cache');
}

// Track approved milestones for webhook dispatch
const approvedMilestones: Array<{ type: string; payload: unknown }> = [];

/** Current indexer lag in ledgers (latestChainLedger - lastIndexedLedger). Reset after each poll. */
export let indexerLedgerLag = 0;

/** Threshold in ledgers above which a warning is logged. Configurable via INDEXER_LAG_WARN_THRESHOLD. */
function getLagWarnThreshold(): number {
  return parseInt(process.env.INDEXER_LAG_WARN_THRESHOLD ?? '100', 10);
}

/** Configurable finality margin delays treating the most recent N ledgers as immutable. */
function getFinalityMargin(): number {
  return parseInt(process.env.INDEXER_FINALITY_MARGIN ?? '10', 10);
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
    'INSERT OR IGNORE INTO events (type, ledger, ledger_hash, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const lastIndexed = fetchLastIndexedLedger();
  const margin = getFinalityMargin();
  const fromLedger = Math.max(0, lastIndexed > margin ? lastIndexed - margin : 0);

  const response = await server.getEvents({
    startLedger: fromLedger || undefined,
    filters: [{ type: 'contract', contractIds: [config.contractId] }],
  });

  const lagAfterPoll = Math.max(0, response.latestLedger - (lastIndexed > 0 ? lastIndexed - 1 : response.latestLedger));
  indexerLedgerLag = lagAfterPoll;
  const threshold = getLagWarnThreshold();
  if (lagAfterPoll > threshold) {
    logger.warn(`[indexer] ledger lag=${lagAfterPoll} exceeds threshold=${threshold}`);
  }

  if (!response.events.length) return;

  const webhookEvents: Array<{ type: string; payload: unknown }> = [];

  const processBatch = db.transaction((events: typeof response.events) => {
    // 1. Reorg detection
    const overlappingEvents = db.prepare('SELECT ledger, ledger_hash FROM events WHERE ledger >= ?').all(fromLedger) as { ledger: number, ledger_hash: string | null }[];
    const existingHashes = new Map<number, string>();
    for (const row of overlappingEvents) {
      if (row.ledger_hash) existingHashes.set(row.ledger, row.ledger_hash);
    }

    let reorgLedger: number | null = null;
    for (const raw of events) {
      const existingHash = existingHashes.get(raw.ledger);
      const incomingHash = (raw as any).ledgerHash ?? (raw as any).pagingToken ?? raw.txHash;
      if (existingHash && incomingHash && existingHash !== incomingHash) {
        reorgLedger = raw.ledger;
        break;
      }
    }

    if (reorgLedger !== null) {
      logger.warn(`[indexer] Reorg detected at ledger ${reorgLedger}! Rolling back...`);
      rollbackEventsFromLedger(reorgLedger);
    }

    // 2. Insert events
    for (const raw of events) {
      const type = raw.topic[0]?.value() as string;
      const payload = normalizePayload((raw.value?.value() as unknown as Record<string, unknown>) ?? {});
      const eventId = normalizeEventId(config.contractId, raw.ledger, raw.txHash);
      const createdAt = raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt).getTime() : Date.now();
      const ledgerHash = (raw as any).ledgerHash ?? (raw as any).pagingToken ?? raw.txHash;

      onBeforeInsert(eventId);
      insert.run(type, raw.ledger, ledgerHash, raw.txHash, JSON.stringify(payload), createdAt);
      onAfterInsert(eventId);

      if (type === 'player_registered') {
        const playerId = payload.player_id as string;
        insertOrUpdatePlayer({
          player_id: playerId,
          wallet: payload.wallet as string,
          position: payload.position as string | undefined,
          region: payload.region as string | undefined,
          metadata_uri: payload.metadata_uri as string | undefined,
          created_at: raw.ledger,
        });
        // Invalidate cache after player registration
        const cache = getCache();
        cache.invalidatePlayerCache(playerId);
      } else if (type === 'milestone_submitted') {
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
          const approvedMilestoneCount = queryEvents('milestone_approved').filter(
            (e) => e.payload.player_id === playerId,
          ).length;
          updatePlayerProgress(playerId, tierForApprovedMilestones(approvedMilestoneCount));
          // Invalidate cache after player progress update
          const cache = getCache();
          cache.invalidatePlayerCache(playerId);
        }
        webhookEvents.push({ type, payload });
      }
    }

    // 3. Update last indexed ledger safely inside the transaction!
    const latest = events.at(-1)!;
    persistLastIndexedLedger(latest.ledger + 1);
  });

  processBatch(response.events);

  for (const { type, payload } of webhookEvents) {
    dispatchEventWebhook(type, payload).catch((err: unknown) => {
      logger.warn(`[indexer] webhook dispatch failed for ${type}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const latest = response.events.at(-1)!;
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
 * Persist an on-chain trial offer submission. Deduped by tx_hash (INSERT OR
 * IGNORE) so replaying the same on-chain event never creates duplicate rows.
 */
export function insertTrialOffer(
  scoutWallet: string,
  playerId: string,
  detailsUri: string,
  txHash: string,
  createdAt: number,
): void {
  getDb().prepare(
    `INSERT OR IGNORE INTO trial_offer_events (scout_wallet, player_id, details_uri, tx_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(scoutWallet, playerId, detailsUri, txHash, createdAt);
}

/** Return all trial offer events for a scout wallet, most recent first. */
export function getTrialOffers(scoutWallet: string): TrialOfferEventRow[] {
  return getDb().prepare(
    `SELECT scout_wallet, player_id, details_uri, tx_hash, created_at
     FROM trial_offer_events WHERE scout_wallet = ? ORDER BY created_at DESC`
  ).all(scoutWallet) as TrialOfferEventRow[];
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
 * Uses INSERT OR REPLACE so a re-registration after revocation resets the row.
 */
export function insertValidator(wallet: string, txHash?: string): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO validators (wallet, registered_at, revoked_at, tx_hash)
     VALUES (?, ?, NULL, ?)`
  ).run(wallet, Math.floor(Date.now() / 1000), txHash ?? null);
}

/**
 * Mark an existing validator as revoked by setting revoked_at.
 * No-op if the wallet is not found.
 */
export function revokeValidatorRow(wallet: string, txHash?: string): void {
  getDb().prepare(
    `UPDATE validators SET revoked_at = ?, tx_hash = ? WHERE wallet = ?`
  ).run(Math.floor(Date.now() / 1000), txHash ?? null, wallet);
}

/**
 * Return all validator rows ordered by registration time descending.
 */
export function getAllValidators(): ValidatorRow[] {
  return getDb().prepare(
    `SELECT wallet, registered_at, revoked_at, tx_hash FROM validators ORDER BY registered_at DESC`
  ).all() as ValidatorRow[];
}

/**
 * Return a single validator row by wallet address, or null if not found.
 */
export function getValidatorByWallet(wallet: string): ValidatorRow | null {
  return (getDb().prepare(
    `SELECT wallet, registered_at, revoked_at, tx_hash FROM validators WHERE wallet = ?`
  ).get(wallet) as ValidatorRow | undefined) ?? null;
}

