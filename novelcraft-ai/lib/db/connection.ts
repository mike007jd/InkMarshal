// Hard build-time wall: this module loads the native better-sqlite3 addon and is
// the local-DB entry point. `server-only` makes any client component that
// transitively imports it a BUILD error, turning the long-standing "never import
// the DB from client code" convention into an enforced module boundary (Phase 2).
import 'server-only';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { nowIso } from '@/lib/utils';
import { LOCAL_USER_ID, LOCAL_USER_EMAIL } from '@/lib/local-user';
import { resolveLocalDbPath } from '@/lib/db-local-path';
import {
  assertCurrentSchema,
  DatabaseFromNewerAppVersionError,
  IncompatibleDatabaseSchemaError,
  initializeCurrentSchema,
} from '@/lib/db/migrations';
import { seedPromptTemplates } from '@/lib/prompt-seed';

let _db: Database.Database | null = null;

/**
 * Defense-in-depth runtime guard (D2 / 04-routes R5). The "web runtime never
 * reaches the local DB" invariant otherwise lives only in `proxy.ts`
 * (`isProductionWebRuntime`) and scattered caller checks. Mirror that exact
 * condition here so opening the DB is a hard wall, not a convention: a
 * misconfigured production web deploy can never silently create/read a stray
 * SQLite file. Stays inert under vitest (`NODE_ENV === 'test'`) and in dev.
 */
function assertDbRuntimeAllowed(): void {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.INKMARSHAL_RUNTIME !== 'desktop'
  ) {
    throw new Error('InkMarshal: local database is not available in the web runtime');
  }
}

function seedLocalUser(db: Database.Database): void {
  const now = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, email, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(LOCAL_USER_ID, LOCAL_USER_EMAIL, now, now);
}

export function getDb(): Database.Database {
  if (_db) return _db;
  assertDbRuntimeAllowed();
  const dbPath = resolveLocalDbPath();
  let db: Database.Database | undefined;
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const hasExistingDatabase = existsSync(dbPath) && statSync(dbPath).size > 0;
    if (hasExistingDatabase) {
      const verifier = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        assertCurrentSchema(verifier);
      } finally {
        verifier.close();
      }
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    if (!hasExistingDatabase) {
      initializeCurrentSchema(db);
    }
    seedLocalUser(db);
    seedPromptTemplates(db);
  } catch (e) {
    db?.close();
    // Fail closed on a newer-than-supported database: surface the typed error
    // unchanged so the shell can tell the user to update rather than treating it
    // as a generic open failure. The handle is already closed — no read/write
    // touched the newer on-disk shape.
    if (
      e instanceof DatabaseFromNewerAppVersionError ||
      e instanceof IncompatibleDatabaseSchemaError
    ) throw e;
    throw new Error(
      `InkMarshal: could not open local database at ${dbPath}: ${(e as Error).message}`,
      { cause: e },
    );
  }
  _db = db;
  return db;
}

export function closeDbForTest(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* swallow */
    }
    _db = null;
  }
}
