/**
 * PostgreSQL driver implementation.
 * Provides synchronous-style interface wrapping the async pg library.
 * 
 * Note: This driver requires async initialization via connect(),
 * which is called by the refactored initDb() function.
 */

import { Client, type ClientConfig } from 'pg';
import { DbDriver } from './driver';

/** SSL option accepted by the PostgresDriver constructor. */
export type PostgresSslOption =
  /** Enable SSL with full certificate verification (recommended for managed providers). */
  | true
  /** Enable SSL but skip certificate verification (dev/staging with self-signed certs). */
  | 'no-verify'
  /** Disable SSL entirely (local / private-network Postgres without TLS). */
  | false;

export class PostgresDriver implements DbDriver {
  private client: Client;
  private inTransaction = false;

  constructor(connectionString: string, ssl: PostgresSslOption = false) {
    const clientConfig: ClientConfig = { connectionString };

    if (ssl === true) {
      // Full certificate verification — the default secure mode for production.
      clientConfig.ssl = { rejectUnauthorized: true };
    } else if (ssl === 'no-verify') {
      // SSL transport enabled, but certificate not verified.  Use only in dev/staging
      // with self-signed certificates — never in production.
      clientConfig.ssl = { rejectUnauthorized: false };
    }
    // When ssl === false, no ssl property is set — pg connects without TLS.

    this.client = new Client(clientConfig);
  }

  /**
   * Establish the connection to PostgreSQL.
   * Must be awaited before any query methods are called.
   */
  async connect(): Promise<void> {
    await this.client.connect();
  }

  /**
   * Execute a query that returns rows.
   * Note: This method BLOCKS using an anti-pattern suitable only for database operations
   * in a server startup context. Regular application code should not use this pattern.
   */
  all<T>(sql: string, params?: unknown[]): T[] {
    if (!this.client) {
      throw new Error('PostgreSQL client not connected');
    }
    const result = this.querySync(sql, params);
    return (result.rows || []) as T[];
  }

  get<T>(sql: string, params?: unknown[]): T | undefined {
    const rows = this.all<T>(sql, params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  value<T>(sql: string, params?: unknown[]): T | undefined {
    const row = this.get<Record<string, unknown>>(sql, params);
    if (!row) return undefined;
    const values = Object.values(row);
    return values.length > 0 ? (values[0] as T) : undefined;
  }

  run(sql: string, params?: unknown[]): { changes: number; lastId: number } {
    if (!this.client) {
      throw new Error('PostgreSQL client not connected');
    }

    const result = this.querySync(sql, params);

    // Extract lastId from RETURNING id clause
    let lastId = 0;
    if (result.rows && result.rows.length > 0) {
      const firstRow = result.rows[0] as Record<string, unknown>;
      if ('id' in firstRow) {
        lastId = Number(firstRow.id);
      }
    }

    return {
      changes: result.rowCount ?? 0,
      lastId,
    };
  }

  exec(sql: string): void {
    if (!this.client) {
      throw new Error('PostgreSQL client not connected');
    }
    this.querySync(sql, []);
  }

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      // Already in a transaction
      return fn();
    }

    try {
      this.inTransaction = true;
      this.querySync('BEGIN', []);

      const result = fn();

      this.querySync('COMMIT', []);
      this.inTransaction = false;

      return result;
    } catch (err) {
      this.inTransaction = false;
      try {
        this.querySync('ROLLBACK', []);
      } catch (rollbackErr) {
        // Log but don't throw - connection may be in bad state
        console.error('[db] Rollback failed:', rollbackErr);
      }
      throw err;
    }
  }

  close(): void {
    if (this.client) {
      this.client.end().catch((err) => {
        console.error('[db] Error closing PostgreSQL connection:', err);
      });
    }
  }

  /**
   * Execute a query synchronously using a busy-wait pattern.
   * This is ONLY acceptable for server startup and database operations
   * where blocking is expected. Do NOT use for application request handling.
   * 
   * This workaround exists because:
   * 1. The current application code expects synchronous database access
   * 2. The pg library is async-only
   * 3. Refactoring all 1000+ database calls to async is a large undertaking
   * 
   * Future improvement: Refactor initDb() and all database callers to be async.
   */
  private querySync(sql: string, params?: unknown[]): any {
    let result: any = null;
    let error: any = null;
    let done = false;

    // Fire off the async query
    this.client.query(sql, params).then(
      (res) => {
        result = res;
        done = true;
      },
      (err) => {
        error = err;
        done = true;
      }
    );

    // Busy-wait with timeout (suitable for server operations where latency is acceptable)
    const startTime = Date.now();
    const timeout = 60000; // 60 seconds
    while (!done) {
      if (Date.now() - startTime > timeout) {
        throw new Error(
          'PostgreSQL query timeout after 60 seconds. Connection may be lost or query is hanging.'
        );
      }
      // Minimal CPU spin - this is a temporary workaround
    }

    if (error) throw error;
    return result;
  }
}
