// Hard build-time wall: this module loads the native better-sqlite3 addon and is
// the local-DB entry point. `server-only` makes any client component that
// transitively imports it a BUILD error, turning the long-standing "never import
// the DB from client code" convention into an enforced module boundary (Phase 2).
import 'server-only';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { nowIso } from '@/lib/utils';
import { LOCAL_USER_ID, LOCAL_USER_EMAIL } from '@/lib/local-user';
import { resolveLocalDbPath } from '@/lib/db-local-path';
import {
  DatabaseFromNewerAppVersionError,
  IncompatibleDatabaseSchemaError,
  LocalDatabaseUnavailableError,
  PreMigrationBackupRequiredError,
  ensureCurrentSchema,
  initializeCurrentSchema,
  inspectSchemaOpenPlan,
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

function applyConnectionPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
}

function sourceDatabaseFileState(dbPath: string): string {
  return [dbPath, `${dbPath}-wal`].map(filePath => {
    if (!existsSync(/*turbopackIgnore: true*/ filePath)) return 'absent';
    const stat = statSync(/*turbopackIgnore: true*/ filePath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }).join('|');
}

function copySnapshotFile(source: string, destination: string): void {
  const result = spawnSync('/bin/cp', ['-p', source, destination], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`Database snapshot copy failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

/** @internal Exported only for the WAL checkpoint race regression test. */
export function inspectExistingDatabaseWithoutTouchingSource(
  dbPath: string,
  afterMainCopy?: () => void,
): string {
  // The published desktop target is macOS; keep the trace root literal so the
  // bundled Next server does not pull the repository into its NFT file list.
  const snapshotDir = mkdtempSync('/tmp/inkmarshal-db-inspection-');
  const snapshotPath = `${snapshotDir}${path.sep}inkmarshal.db`;
  try {
    const walPath = `${dbPath}-wal`;
    const snapshotWalPath = `${snapshotPath}-wal`;
    let stableSnapshot = false;
    let stableSourceState = '';
    for (let attempt = 0; attempt < 3 && !stableSnapshot; attempt += 1) {
      const sourceStateBefore = sourceDatabaseFileState(dbPath);
      rmSync(/*turbopackIgnore: true*/ snapshotPath, { force: true });
      rmSync(/*turbopackIgnore: true*/ snapshotWalPath, { force: true });
      try {
        copySnapshotFile(dbPath, snapshotPath);
        afterMainCopy?.();
        if (existsSync(/*turbopackIgnore: true*/ walPath)) {
          copySnapshotFile(walPath, snapshotWalPath);
        }
      } catch {
        continue;
      }
      const sourceStateAfter = sourceDatabaseFileState(dbPath);
      stableSnapshot = sourceStateBefore === sourceStateAfter;
      if (stableSnapshot) stableSourceState = sourceStateAfter;
    }
    if (!stableSnapshot) {
      throw new LocalDatabaseUnavailableError(
        'InkMarshal could not capture a stable read-only database snapshot for compatibility inspection.',
      );
    }
    const verifier = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      inspectSchemaOpenPlan(verifier);
    } finally {
      verifier.close();
    }
    return stableSourceState;
  } finally {
    rmSync(/*turbopackIgnore: true*/ snapshotDir, { recursive: true, force: true });
  }
}

export function getDb(): Database.Database {
  if (_db) return _db;
  assertDbRuntimeAllowed();
  const dbPath = resolveLocalDbPath();
  let db: Database.Database | undefined;
  let inspectedSourceState: string | null = null;
  try {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const hasExistingDatabase = existsSync(dbPath) && statSync(dbPath).size > 0;
    if (hasExistingDatabase) {
      // Inspect a byte-for-byte main/WAL snapshot. SQLite may create or update
      // shared-memory sidecars even for readonly WAL connections, so the
      // published source directory must not be opened during fail-closed checks.
      inspectedSourceState = inspectExistingDatabaseWithoutTouchingSource(dbPath);
    }

    if (inspectedSourceState && inspectedSourceState !== sourceDatabaseFileState(dbPath)) {
      throw new LocalDatabaseUnavailableError(
        'InkMarshal local database changed after compatibility inspection; retrying is safe.',
      );
    }
    db = new Database(dbPath);
    if (hasExistingDatabase) {
      ensureCurrentSchema(db);
    } else {
      initializeCurrentSchema(db);
    }
    applyConnectionPragmas(db);
    seedLocalUser(db);
    seedPromptTemplates(db);
  } catch (e) {
    db?.close();
    // Fail closed on a newer-than-supported / incompatible database: surface the
    // typed error unchanged so the shell can tell the user to update rather than
    // treating it as a generic open failure. The handle is already closed — no
    // read/write touched an unsupported on-disk shape.
    if (
      e instanceof DatabaseFromNewerAppVersionError ||
      e instanceof IncompatibleDatabaseSchemaError ||
      e instanceof PreMigrationBackupRequiredError
    ) throw e;
    throw new LocalDatabaseUnavailableError(
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
