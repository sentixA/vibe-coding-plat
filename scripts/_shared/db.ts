import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqliteHandle = {
  exec(sql: string): void;
  prepare(sql: string): {
    all: (...args: unknown[]) => unknown[];
    get: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => unknown;
  };
  close(): void;
  pragma(p: string): unknown;
};

const cache = new Map<string, SqliteHandle>();

/**
 * Open (or reuse) a SQLite database at the given absolute path.
 * Lazily imports `better-sqlite3` so M1 doesn't force a native build for callers
 * that never touch the DB. Module owners (M2/M3) install the dep in their
 * workspace package.
 */
export async function openSqlite(absPath: string): Promise<SqliteHandle> {
  const cached = cache.get(absPath);
  if (cached) return cached;
  mkdirSync(dirname(absPath), { recursive: true });
  let Database: new (p: string) => SqliteHandle;
  try {
    const mod: any = await import('better-sqlite3');
    Database = mod.default ?? mod;
  } catch (err) {
    throw new Error(
      `better-sqlite3 not installed. Add it to the relevant package's deps.\n` +
        `Original error: ${(err as Error).message}`,
    );
  }
  const db = new Database(absPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  cache.set(absPath, db);
  return db;
}

export function closeAll(): void {
  for (const db of cache.values()) {
    try { db.close(); } catch { /* ignore */ }
  }
  cache.clear();
}
