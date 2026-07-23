/**
 * Database driver abstraction layer.
 * Supports both SQLite and PostgreSQL backends with a consistent interface.
 */

export interface DbDriver {
  /**
   * Execute a query that returns rows.
   */
  all<T>(sql: string, params?: unknown[]): T[];

  /**
   * Execute a query that returns a single row.
   */
  get<T>(sql: string, params?: unknown[]): T | undefined;

  /**
   * Execute a query that returns a single value.
   */
  value<T>(sql: string, params?: unknown[]): T | undefined;

  /**
   * Execute a statement that modifies data (INSERT, UPDATE, DELETE).
   * Returns info object with changes count and last insert ID.
   */
  run(sql: string, params?: unknown[]): { changes: number; lastId: number };

  /**
   * Execute raw SQL (for migrations, pragmas, etc).
   */
  exec(sql: string): void;

  /**
   * Execute a function within a transaction. Commits on success, rolls back on error.
   */
  transaction<T>(fn: () => T): T;

  /**
   * Close the database connection.
   */
  close(): void;
}

export type DbDriverType = 'sqlite' | 'postgres';
