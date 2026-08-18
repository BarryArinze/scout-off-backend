import fs from 'fs';
import path from 'path';
import { DbDriver, DbTxHandle } from './driver';
import { PostgresDriver } from './postgres-driver';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db');

export async function runMigrations(driver: DbDriver): Promise<void> {
  // Dialect selection is derived from the `driver` instance actually passed
  // in, not from the process-wide config.dbDriver — callers (notably tests)
  // legitimately construct a SqliteDriver directly regardless of what
  // DB_DRIVER is set to for the rest of the process, and applying
  // PostgreSQL-dialect migration SQL against a real SQLite connection in
  // that case throws a syntax error (e.g. "near EXISTS").
  const isPostgres = driver instanceof PostgresDriver;

  // Create migrations table
  const createMigrationsTableSql = isPostgres
    ? 'CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)'
    : `CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`;

  await driver.exec(createMigrationsTableSql);

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.includes('_postgres'))
    .sort();

  for (const file of files) {
    const already = await driver.get<{ id: string }>(
      'SELECT id FROM migrations WHERE id = ?',
      [file]
    );

    if (already) continue;

    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    // For PostgreSQL migrations, use the _postgres version if available
    if (isPostgres) {
      const postgresFile = file.replace('.sql', '_postgres.sql');
      const postgresPath = path.join(MIGRATIONS_DIR, postgresFile);
      if (fs.existsSync(postgresPath)) {
        sql = fs.readFileSync(postgresPath, 'utf8');
      } else {
        // Fall back to converting SQLite SQL to PostgreSQL
        sql = convertSqlToPostgres(sql);
      }
    }

    await driver.transaction(async (tx: DbTxHandle) => {
      await tx.exec(sql);
      await tx.run('INSERT INTO migrations (id, applied_at) VALUES (?, ?)', [
        file,
        Date.now(),
      ]);
    });
  }
}

/**
 * Convert SQLite SQL to PostgreSQL SQL.
 * Handles common dialect differences.
 */
function convertSqlToPostgres(sql: string): string {
  let converted = sql;

  // Replace AUTOINCREMENT with SERIAL
  converted = converted.replace(
    /INTEGER PRIMARY KEY AUTOINCREMENT/gi,
    'SERIAL PRIMARY KEY'
  );

  // Replace INSERT OR IGNORE with ON CONFLICT DO NOTHING
  converted = converted.replace(
    /INSERT OR IGNORE INTO/gi,
    'INSERT INTO'
  );

  // Add ON CONFLICT clause for INSERT ... INTO that would have had OR IGNORE
  // This is a heuristic: if we see INSERT INTO after OR IGNORE removal and
  // there's a UNIQUE constraint, assume ON CONFLICT DO NOTHING is needed
  if (!converted.includes('ON CONFLICT')) {
    converted = converted.replace(
      /INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES/gi,
      (match, table, columns) => {
        // Try to detect if this needs ON CONFLICT based on common patterns
        if (sql.includes('INSERT OR IGNORE')) {
          return match + ' ON CONFLICT DO NOTHING ';
        }
        return match;
      }
    );
  }

  // Replace datetime('now') with now()
  converted = converted.replace(/datetime\('now'\)/gi, "now()");

  return converted;
}
