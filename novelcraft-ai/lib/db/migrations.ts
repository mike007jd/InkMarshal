import Database from 'better-sqlite3';
import { migrations as allMigrations, type Migration } from '@/lib/db/schema';

const SCHEMA_VERSION_DDL = `
CREATE TABLE IF NOT EXISTS _schema_version (
  version     INTEGER NOT NULL,
  description TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);
`;

/**
 * DB-02: raised when the database was written by a NEWER app than this one (its
 * recorded schema version exceeds every migration we know about). Opening it
 * fails closed — the caller must NOT fall through to reading/writing, or a newer
 * on-disk shape would be silently corrupted by an older binary.
 */
export class DatabaseFromNewerAppVersionError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly appMaxVersion: number,
  ) {
    super(
      `Local database schema ${dbVersion} was created by a newer version of InkMarshal ` +
        `than this build supports (up to schema ${appMaxVersion}). Refusing to open it to ` +
        `avoid corrupting your data — please update the app.`,
    );
    this.name = 'DatabaseFromNewerAppVersionError';
  }
}

function currentSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare('SELECT version FROM _schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;
  return row?.version ?? 0;
}

function maxKnownVersion(migrations: Migration[]): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

export function inspectMigrations(
  db: Database.Database,
  migrations: Migration[] = allMigrations,
): { current: number; pending: number; pendingDestructive: boolean } {
  db.exec(SCHEMA_VERSION_DDL);
  const current = currentSchemaVersion(db);
  const pending = migrations.filter(m => m.version > current);
  return {
    current,
    pending: pending.length,
    pendingDestructive: pending.some(m => m.destructive === true),
  };
}

/**
 * DB-02: create a verified snapshot of the live database next to it before a
 * migration touches an already-populated database. `VACUUM INTO` writes a
 * consistent copy without holding a long lock, then we reopen the copy and run
 * `PRAGMA integrity_check`. Returns the backup path, or null when there is
 * nothing to back up (in-memory or a fresh/empty database). Throws if the
 * snapshot cannot be written or fails its integrity check — the caller decides
 * whether that is fatal.
 */
export function createVerifiedBackup(db: Database.Database, fromVersion: number): string | null {
  const dbPath = db.name;
  if (!dbPath || dbPath === ':memory:') return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.pre-migration-v${fromVersion}-${stamp}.bak`;
  // VACUUM INTO cannot run inside an open transaction; callers invoke this
  // before BEGIN.
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

  let backup: Database.Database | undefined;
  try {
    backup = new Database(backupPath, { readonly: true });
    const result = backup.pragma('integrity_check', { simple: true });
    if (result !== 'ok') {
      throw new Error(`integrity_check on the pre-migration backup returned "${String(result)}"`);
    }
  } finally {
    backup?.close();
  }
  return backupPath;
}

export function runMigrations(
  db: Database.Database,
  migrations: Migration[] = allMigrations,
  // Injectable so the destructive-backup gate can be exercised without forcing a
  // real VACUUM INTO failure; production always uses createVerifiedBackup.
  backupFn: (db: Database.Database, fromVersion: number) => string | null = createVerifiedBackup,
): void {
  db.exec(SCHEMA_VERSION_DDL);
  const current = currentSchemaVersion(db);
  const appMax = maxKnownVersion(migrations);

  // Fail closed if the on-disk schema is newer than anything this build knows.
  if (current > appMax) {
    throw new DatabaseFromNewerAppVersionError(current, appMax);
  }

  const pending = migrations
    .filter(m => m.version > current)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    mirrorUserVersion(db, current);
    return;
  }

  // Snapshot a populated database before migrating. A missing/failed backup is
  // fatal when any pending step is destructive; otherwise (purely additive
  // steps) we log and proceed so a backup-dir hiccup can't wedge startup.
  if (current > 0) {
    const hasDestructive = pending.some(m => m.destructive === true);
    try {
      backupFn(db, current);
    } catch (e) {
      if (hasDestructive) {
        throw new Error(
          `Refusing to run a destructive migration without a verified backup: ${(e as Error).message}`,
          { cause: e },
        );
      }
      console.warn(
        `[migrations] pre-migration backup failed (proceeding: no destructive step pending): ${(e as Error).message}`,
      );
    }
  }

  const targetVersion = pending[pending.length - 1]?.version ?? current;
  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    for (const m of pending) {
      try {
        db.exec(m.sql);
        db.prepare(
          'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
        ).run(m.version, m.description, new Date().toISOString());
      } catch (e) {
        throw new Error(
          `Schema migration ${m.version} "${m.description}" failed. Cause: ${(e as Error).message}`,
          { cause: e },
        );
      }
    }
    db.exec('COMMIT');
    transactionOpen = false;
    mirrorUserVersion(db, targetVersion);
  } catch (e) {
    if (transactionOpen) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original schema failure.
      }
    }
    throw e;
  }
}

function mirrorUserVersion(db: Database.Database, version: number): void {
  try {
    db.pragma(`user_version = ${version}`);
  } catch {
    // user_version is a cross-check, not the source of truth.
  }
}
