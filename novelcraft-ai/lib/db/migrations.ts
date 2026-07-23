import Database from 'better-sqlite3';

import {
  CURRENT_SCHEMA_TABLES,
  CURRENT_SCHEMA_VERSION,
  currentSchemaSql,
} from '@/lib/db/schema';

const SCHEMA_VERSION_DDL = `
CREATE TABLE _schema_version (
  version     INTEGER NOT NULL,
  description TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);
`;

const RESET_GUIDANCE =
  'Run `pnpm local-state:reset -- --confirm-delete-inkmarshal-local-state` only if you intend to delete this unpublished local state.';

export class DatabaseFromNewerAppVersionError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly appMaxVersion: number,
  ) {
    super(
      `Local database schema ${dbVersion} was created by a newer version of InkMarshal ` +
        `than this build supports (schema ${appMaxVersion}). Refusing to open it to avoid ` +
        'corrupting your data; update InkMarshal before opening this database.',
    );
    this.name = 'DatabaseFromNewerAppVersionError';
  }
}

export class IncompatibleDatabaseSchemaError extends Error {
  constructor(message: string) {
    super(`InkMarshal local database is incompatible with this prelaunch build: ${message} ${RESET_GUIDANCE}`);
    this.name = 'IncompatibleDatabaseSchemaError';
  }
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(row => (row as { name: string }).name)
    .filter(name => !name.startsWith('sqlite_'));
}

function recordedSchemaVersion(db: Database.Database): number {
  const hasVersionTable = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_schema_version'")
    .get() as { present: number } | undefined;
  if (!hasVersionTable) {
    throw new IncompatibleDatabaseSchemaError('the nonempty database has no schema marker.');
  }
  const rows = db
    .prepare('SELECT version FROM _schema_version ORDER BY version DESC')
    .all() as Array<{ version: number }>;
  if (rows.length !== 1 || !Number.isInteger(rows[0].version)) {
    throw new IncompatibleDatabaseSchemaError('the schema marker is missing or ambiguous.');
  }
  return rows[0].version;
}

/** Read-only validation for an existing database. Never creates tables, seeds
 * rows, mirrors pragmas, or attempts to reinterpret unpublished old shapes. */
export function assertCurrentSchema(db: Database.Database): void {
  const version = recordedSchemaVersion(db);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new DatabaseFromNewerAppVersionError(version, CURRENT_SCHEMA_VERSION);
  }
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new IncompatibleDatabaseSchemaError(
      `found schema ${version}; this build requires schema ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  const actualTables = tableNames(db);
  if (actualTables.join('\n') !== CURRENT_SCHEMA_TABLES.join('\n')) {
    throw new IncompatibleDatabaseSchemaError('the table set does not match the current baseline.');
  }
  const integrity = db.pragma('quick_check', { simple: true });
  if (integrity !== 'ok') {
    throw new IncompatibleDatabaseSchemaError(`SQLite quick_check returned ${String(integrity)}.`);
  }
}

/** Initialize one disposable empty database directly at the current product
 * shape. There is intentionally no migration chain in this prelaunch app. */
export function initializeCurrentSchema(
  db: Database.Database,
  bootstrapRows: () => void = () => undefined,
): void {
  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    db.exec(currentSchemaSql);
    db.exec(SCHEMA_VERSION_DDL);
    db.prepare(
      'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
    ).run(CURRENT_SCHEMA_VERSION, 'current_prelaunch_baseline', new Date().toISOString());
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    bootstrapRows();
    db.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
  assertCurrentSchema(db);
}
