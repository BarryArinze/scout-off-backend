/**
 * SQLite driver implementation.
 * Uses better-sqlite3 for fast, synchronous database access.
 */

import Database from 'better-sqlite3';
import { DbDriver } from './driver';

export class SqliteDriver implements DbDriver {
  constructor(private db: Database.Database) {}

  all<T>(sql: string, params?: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.all(...params) : stmt.all()) as T[];
  }

  get<T>(sql: string, params?: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.get(...params) : stmt.get()) as T | undefined;
  }

  value<T>(sql: string, params?: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    const row = params ? stmt.get(...params) : stmt.get();
    if (!row) return undefined;
    // Return the first column value
    return Object.values(row as Record<string, unknown>)[0] as T;
  }

  run(sql: string, params?: unknown[]): { changes: number; lastId: number } {
    const stmt = this.db.prepare(sql);
    const info = params ? stmt.run(...params) : stmt.run();
    return {
      changes: info.changes,
      lastId: typeof info.lastInsertRowid === 'number' ? info.lastInsertRowid : 0,
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
