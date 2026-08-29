import Database from 'better-sqlite3';
import config from '../config';
import { EventRecord, ContractEventType } from '../types';
import { runMigrations } from './migrate';
import { logger } from '../utils/logger';

function slowQueryThresholdMs(): number {
  return parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? '50', 10);
}

/** Runs fn(), logs a warn if it takes longer than SLOW_QUERY_THRESHOLD_MS. */
export function timedQuery<T>(sql: string, fn: () => T): T {
  const start = Date.now();
  const result = fn();
  const duration = Date.now() - start;
  if (duration >= slowQueryThresholdMs()) {
    logger.warn(`[db] slow query ${duration}ms: ${sql}`);
  }
  return result;
}

// ─── Connection & schema ──────────────────────────────────────────────────────

let _db: Database.Database | null = null;

/**
 * Initialise the database connection and run pending migrations.
 * Must be called once at application startup before any query helper is used.
 * Safe to call in tests with DB_PATH=:memory: set before import.
 */
export function initDb(): void {
  _db = new Database(config.dbPath);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type      TEXT NOT NULL,
      ledger    INTEGER NOT NULL,
      tx_hash   TEXT NOT NULL UNIQUE,
      payload   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indexer_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players (
      player_id      TEXT    PRIMARY KEY,
      wallet         TEXT    NOT NULL,
      position       TEXT,
      region         TEXT,
      metadata_uri   TEXT,
      progress_level INTEGER DEFAULT 0,
      created_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_players_region   ON players (region);
    CREATE INDEX IF NOT EXISTS idx_players_position ON players (position);
    CREATE INDEX IF NOT EXISTS idx_players_tier     ON players (progress_level);
    CREATE TABLE IF NOT EXISTS validator_stats (
      wallet             TEXT PRIMARY KEY,
      milestones_approved INTEGER DEFAULT 0,
      milestones_rejected INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pending_milestones (
      milestone_id    TEXT PRIMARY KEY,
      player_id       TEXT NOT NULL,
      validator_wallet TEXT NOT NULL,
      milestone_type  TEXT NOT NULL,
      evidence_uri    TEXT NOT NULL,
      submitted_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_milestones_validator ON pending_milestones (validator_wallet);
    CREATE INDEX IF NOT EXISTS idx_pending_milestones_player ON pending_milestones (player_id);
  `);
  // Run SQL migrations (player_profile_history, idempotency_keys, etc.)
  runMigrations(_db);
}

export function getDb(): Database.Database {
  if (!_db) throw new Error("Database not initialised — call initDb() first");
  return _db;
}

// ─── State helpers ────────────────────────────────────────────────────────────

export function getLastLedger(): number {
  const sql = 'SELECT value FROM indexer_state WHERE key = ?';
  const row = timedQuery(sql, () =>
    getDb().prepare(sql).get('last_ledger') as { value: string } | undefined
  );
  return row ? parseInt(row.value, 10) : 0;
}

export function setLastLedger(ledger: number): void {
  const sql = 'INSERT INTO indexer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  timedQuery(sql, () => getDb().prepare(sql).run('last_ledger', String(ledger)));
}

// ─── Query helpers ────────────────────────────────────────────────────────────

interface EventRow {
  type: string;
  payload: string;
}

export interface GetEventsOptions {
  limit?: number;
  offset?: number;
}

export function getEvents(
  type?: ContractEventType,
  opts?: GetEventsOptions,
): EventRecord[] {
  const db = getDb();
  const { limit, offset } = opts ?? {};
  const hasPagination = limit !== undefined && offset !== undefined;

  let sql: string;
  let rows: EventRow[];
  if (type && hasPagination) {
    sql = 'SELECT * FROM events WHERE type = ? ORDER BY ledger ASC LIMIT ? OFFSET ?';
    rows = timedQuery(sql, () => db.prepare(sql).all(type, limit, offset) as EventRow[]);
  } else if (type) {
    sql = 'SELECT * FROM events WHERE type = ? ORDER BY ledger ASC';
    rows = timedQuery(sql, () => db.prepare(sql).all(type) as EventRow[]);
  } else if (hasPagination) {
    sql = 'SELECT * FROM events ORDER BY ledger ASC LIMIT ? OFFSET ?';
    rows = timedQuery(sql, () => db.prepare(sql).all(limit, offset) as EventRow[]);
  } else {
    sql = 'SELECT * FROM events ORDER BY ledger ASC';
    rows = timedQuery(sql, () => db.prepare(sql).all() as EventRow[]);
  }

  return rows.map((r) => ({
    source: config.contractId,
    type: r.type as ContractEventType,
    payload: JSON.parse(r.payload),
    contractAddress: config.contractId,
  }));
}

export function getEventsCount(type?: ContractEventType): number {
  const db = getDb();
  const sql = type
    ? 'SELECT COUNT(*) AS count FROM events WHERE type = ?'
    : 'SELECT COUNT(*) AS count FROM events';
  const row = type
    ? timedQuery(sql, () => db.prepare(sql).get(type) as { count: number } | undefined)
    : timedQuery(sql, () => db.prepare(sql).get() as { count: number } | undefined);
  return row?.count ?? 0;
}

// ─── Player table helpers ─────────────────────────────────────────────────────

export interface PlayerRow {
  player_id: string;
  wallet: string;
  position: string | null;
  region: string | null;
  metadata_uri: string | null;
  progress_level: number;
  created_at: number | null;
}

export interface QueryPlayersOptions {
  region?: string;
  position?: string;
  minTier?: number;
  limit?: number;
  offset?: number;
}

export interface PlayerProfileHistoryRow {
  metadata_uri: string;
  changed_at: number;
  tx_hash: string;
}

export function insertPlayerProfileHistory(p: {
  player_id: string;
  metadata_uri: string;
  changed_at: number;
  tx_hash: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO player_profile_history (player_id, metadata_uri, changed_at, tx_hash)
       VALUES (?, ?, ?, ?)`,
    )
    .run(p.player_id, p.metadata_uri, p.changed_at, p.tx_hash);
}

export function getPlayerProfileHistory(
  playerId: string,
): PlayerProfileHistoryRow[] {
  return getDb()
    .prepare(
      `SELECT metadata_uri, changed_at, tx_hash
       FROM player_profile_history
       WHERE player_id = ?
       ORDER BY changed_at DESC`,
    )
    .all(playerId) as PlayerProfileHistoryRow[];
}

export function upsertPlayer(p: {
  player_id: string;
  wallet: string;
  position?: string;
  region?: string;
  metadata_uri?: string;
  created_at?: number;
}): void {
  const sql = `INSERT INTO players (player_id, wallet, position, region, metadata_uri, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         wallet       = excluded.wallet,
         position     = excluded.position,
         region       = excluded.region,
         metadata_uri = excluded.metadata_uri`;
  timedQuery(sql, () =>
    getDb().prepare(sql).run(p.player_id, p.wallet, p.position ?? null, p.region ?? null, p.metadata_uri ?? null, p.created_at ?? null)
  );
}

export function updatePlayerProgress(playerId: string, level: number): void {
  const sql = 'UPDATE players SET progress_level = ? WHERE player_id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(level, playerId));
}

export interface ValidatorStatsRow {
  wallet: string;
  milestones_approved: number;
  milestones_rejected: number;
}

export function incrementValidatorApproved(wallet: string): void {
  const sql = `INSERT INTO validator_stats (wallet, milestones_approved, milestones_rejected)
               VALUES (?, 1, 0)
               ON CONFLICT(wallet) DO UPDATE SET milestones_approved = milestones_approved + 1`;
  timedQuery(sql, () => getDb().prepare(sql).run(wallet));
}

export function incrementValidatorRejected(wallet: string): void {
  const sql = `INSERT INTO validator_stats (wallet, milestones_approved, milestones_rejected)
               VALUES (?, 0, 1)
               ON CONFLICT(wallet) DO UPDATE SET milestones_rejected = milestones_rejected + 1`;
  timedQuery(sql, () => getDb().prepare(sql).run(wallet));
}

export function getValidatorStats(wallet: string): ValidatorStatsRow | null {
  const sql = 'SELECT * FROM validator_stats WHERE wallet = ?';
  return timedQuery(sql, () => 
    (getDb().prepare(sql).get(wallet) as ValidatorStatsRow | undefined) ?? null
  );
}

export interface PendingMilestoneRow {
  milestone_id: string;
  player_id: string;
  validator_wallet: string;
  milestone_type: string;
  evidence_uri: string;
  submitted_at: number;
}

export function insertPendingMilestone(
  milestoneId: string,
  playerId: string,
  validatorWallet: string,
  milestoneType: string,
  evidenceUri: string,
  submittedAt: number
): void {
  const sql = `INSERT OR IGNORE INTO pending_milestones 
               (milestone_id, player_id, validator_wallet, milestone_type, evidence_uri, submitted_at) 
               VALUES (?, ?, ?, ?, ?, ?)`;
  timedQuery(sql, () => getDb().prepare(sql).run(milestoneId, playerId, validatorWallet, milestoneType, evidenceUri, submittedAt));
}

export function removePendingMilestone(milestoneId: string): void {
  const sql = 'DELETE FROM pending_milestones WHERE milestone_id = ?';
  timedQuery(sql, () => getDb().prepare(sql).run(milestoneId));
}

export interface GetPendingMilestonesOptions {
  validatorWallet?: string;
  position?: string;
  region?: string;
  page?: number;
  pageSize?: number;
}

export function getPendingMilestones(options: GetPendingMilestonesOptions): { data: PendingMilestoneRow[], total: number } {
  const db = getDb();
  // We need to join with players to filter by position and region
  let whereConditions: string[] = [];
  let params: (string | number)[] = [];

  if (options.validatorWallet) {
    whereConditions.push('pm.validator_wallet = ?');
    params.push(options.validatorWallet);
  }
  if (options.position) {
    whereConditions.push('p.position = ?');
    params.push(options.position);
  }
  if (options.region) {
    whereConditions.push('p.region = ?');
    params.push(options.region);
  }

  const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // Get total count
  const countSql = `SELECT COUNT(*) AS total FROM pending_milestones pm 
                    LEFT JOIN players p ON pm.player_id = p.player_id 
                    ${whereClause}`;
  const countRow = timedQuery(countSql, () => db.prepare(countSql).get(...params) as { total: number });
  const total = countRow.total;

  // Get paginated data
  const page = options.page || 1;
  const pageSize = options.pageSize || 20;
  const offset = (page - 1) * pageSize;
  const dataSql = `SELECT pm.* FROM pending_milestones pm 
                   LEFT JOIN players p ON pm.player_id = p.player_id 
                   ${whereClause}
                   ORDER BY pm.submitted_at DESC
                   LIMIT ? OFFSET ?`;
  const data = timedQuery(dataSql, () => db.prepare(dataSql).all(...params, pageSize, offset) as PendingMilestoneRow[]);

  return { data, total };
}

export function getPlayerById(playerId: string): PlayerRow | null {
  const sql = 'SELECT * FROM players WHERE player_id = ?';
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(playerId) as PlayerRow | undefined) ?? null
  );
}

function buildPlayerWhereClause(opts: QueryPlayersOptions): { where: string; params: (string | number)[] } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.region) {
    conditions.push("region = ?");
    params.push(opts.region);
  }
  if (opts.position) {
    conditions.push("position = ?");
    params.push(opts.position);
  }
  if (opts.minTier !== undefined) {
    conditions.push("progress_level >= ?");
    params.push(opts.minTier);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

export function queryPlayers(opts: QueryPlayersOptions): PlayerRow[] {
  const { where, params } = buildPlayerWhereClause(opts);
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const sql = `SELECT * FROM players ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  return timedQuery(sql, () =>
    getDb().prepare(sql).all(...params, limit, offset) as PlayerRow[]
  );
}

export function countPlayers(opts: Omit<QueryPlayersOptions, 'limit' | 'offset'>): number {
  const { where, params } = buildPlayerWhereClause(opts);
  const sql = `SELECT COUNT(*) as count FROM players ${where}`;
  return timedQuery(sql, () => {
    const row = getDb().prepare(sql).get(...params) as { count: number };
    return row.count;
  });
}

// ─── Idempotency key helpers ──────────────────────────────────────────────────

export interface IdempotencyRecord {
  key: string;
  status_code: number;
  response: string; // raw JSON string
  created_at: number;
  expires_at: number;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Look up a non-expired idempotency key.
 * Returns the stored record, or null when the key is absent or expired.
 */
export function getIdempotencyRecord(key: string): IdempotencyRecord | null {
  const sql = 'SELECT * FROM idempotency_keys WHERE key = ? AND expires_at > ?';
  const now = Date.now();
  return timedQuery(sql, () =>
    (getDb().prepare(sql).get(key, now) as IdempotencyRecord | undefined) ?? null
  );
}

/**
 * Persist a new idempotency key with its response payload.
 * Silently ignores conflicts — two concurrent requests with the same key
 * will both compute a response but only the first one to commit wins; the
 * second one will then be served the stored value by getIdempotencyRecord.
 */
export function saveIdempotencyRecord(
  key: string,
  statusCode: number,
  body: unknown,
): void {
  const now = Date.now();
  const sql = `
    INSERT INTO idempotency_keys (key, status_code, response, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `;
  timedQuery(sql, () =>
    getDb()
      .prepare(sql)
      .run(key, statusCode, JSON.stringify(body), now, now + IDEMPOTENCY_TTL_MS)
  );
}

/**
 * Delete all idempotency records whose TTL has passed.
 * Call this periodically (e.g., from the indexer poll loop) to keep the table small.
 */
export function purgeExpiredIdempotencyKeys(): number {
  const sql = 'DELETE FROM idempotency_keys WHERE expires_at <= ?';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(Date.now());
    return info.changes;
  });
}

// ─── Webhook delivery helpers ─────────────────────────────────────────────────

export interface WebhookDeliveryRow {
  id: number;
  subscription_id: string;
  event_type: string;
  delivery_id: string;
  attempt_count: number;
  status: 'success' | 'failure';
  status_code: number | null;
  error_message: string | null;
  latency_ms: number | null;
  created_at: number;
}

export interface InsertWebhookDeliveryParams {
  subscriptionId: string;
  eventType: string;
  deliveryId: string;
  attemptCount: number;
  status: 'success' | 'failure';
  statusCode?: number | null;
  errorMessage?: string | null;
  latencyMs?: number | null;
}

/**
 * Persist a webhook delivery attempt record (success or failure).
 * Called by the webhook service after every dispatch.
 */
export function insertWebhookDelivery(p: InsertWebhookDeliveryParams): void {
  const sql = `
    INSERT INTO webhook_deliveries
      (subscription_id, event_type, delivery_id, attempt_count, status, status_code, error_message, latency_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  timedQuery(sql, () =>
    getDb()
      .prepare(sql)
      .run(
        p.subscriptionId,
        p.eventType,
        p.deliveryId,
        p.attemptCount,
        p.status,
        p.statusCode ?? null,
        p.errorMessage ?? null,
        p.latencyMs ?? null,
        Date.now(),
      ),
  );
}

export interface GetWebhookDeliveriesOptions {
  subscriptionId: string;
  limit?: number;
  offset?: number;
}

/** Return paginated delivery records for a given subscription (newest first). */
export function getWebhookDeliveries(
  opts: GetWebhookDeliveriesOptions,
): { data: WebhookDeliveryRow[]; total: number } {
  const db = getDb();
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const countSql =
    'SELECT COUNT(*) AS count FROM webhook_deliveries WHERE subscription_id = ?';
  const total = timedQuery(countSql, () => {
    const row = db.prepare(countSql).get(opts.subscriptionId) as { count: number };
    return row.count;
  });

  const dataSql = `
    SELECT * FROM webhook_deliveries
    WHERE subscription_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `;
  const data = timedQuery(dataSql, () =>
    db.prepare(dataSql).all(opts.subscriptionId, limit, offset) as WebhookDeliveryRow[],
  );

  return { data, total };
}

export interface WebhookDeliverySummary {
  subscription_id: string;
  total: number;
  successes: number;
  failures: number;
  success_rate: number;
  last_success_at: number | null;
}

/**
 * Return a rolled-up success-rate summary for a subscription over the given
 * window (default: last 24 hours).
 */
export function getWebhookDeliverySummary(
  subscriptionId: string,
  windowMs = 24 * 60 * 60 * 1000,
): WebhookDeliverySummary {
  const db = getDb();
  const since = Date.now() - windowMs;

  const sql = `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failures,
      MAX(CASE WHEN status = 'success' THEN created_at ELSE NULL END) AS last_success_at
    FROM webhook_deliveries
    WHERE subscription_id = ? AND created_at >= ?
  `;
  const row = timedQuery(sql, () =>
    db.prepare(sql).get(subscriptionId, since) as {
      total: number;
      successes: number;
      failures: number;
      last_success_at: number | null;
    },
  );

  const total = row.total ?? 0;
  const successes = row.successes ?? 0;
  return {
    subscription_id: subscriptionId,
    total,
    successes,
    failures: row.failures ?? 0,
    success_rate: total === 0 ? 0 : Math.round((successes / total) * 100) / 100,
    last_success_at: row.last_success_at ?? null,
  };
}

/**
 * Delete delivery records older than retentionMs (default 30 days).
 * Call periodically (e.g., from the indexer poll loop) to bound table growth.
 * Returns the number of rows deleted.
 */
export function pruneWebhookDeliveries(retentionMs = 30 * 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - retentionMs;
  const sql = 'DELETE FROM webhook_deliveries WHERE created_at < ?';
  return timedQuery(sql, () => {
    const info = getDb().prepare(sql).run(cutoff);
    return info.changes;
  });
}
