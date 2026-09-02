import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/drizzle/schema';

// The path is runtime configuration, not something the bundler can resolve. Without
// these markers Turbopack traces the whole project into the server bundle trying to
// follow it.
export const DATABASE_PATH = resolve(
  /* turbopackIgnore: true */ process.env.DATABASE_PATH ?? './data/livevods.db',
);

function createConnection() {
  mkdirSync(/* turbopackIgnore: true */ dirname(DATABASE_PATH), { recursive: true });
  const sqlite = new Database(DATABASE_PATH);

  // The worker process writes and the web process reads, concurrently, over the
  // same file. WAL is what lets readers proceed without blocking on the writer —
  // without it the guide would stall every time the poller committed.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Wait rather than throwing SQLITE_BUSY if the writer holds the lock.
  sqlite.pragma('busy_timeout = 5000');

  return drizzle(sqlite, { schema });
}

// Next dev-mode HMR re-evaluates modules; without this the process leaks a file
// handle per reload until SQLite runs out.
const globalForDb = globalThis as unknown as {
  __livevodsDb?: ReturnType<typeof createConnection>;
};

export const db = globalForDb.__livevodsDb ?? createConnection();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__livevodsDb = db;
}

export { schema };
