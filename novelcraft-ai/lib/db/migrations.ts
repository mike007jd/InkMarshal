import Database from 'better-sqlite3';

import {
  computeSchemaFingerprint,
  type SchemaFingerprint,
} from '@/lib/db/schema-fingerprint';
import {
  CURRENT_SCHEMA_DESCRIPTION,
  CURRENT_SCHEMA_VERSION,
  LEGACY_SCHEMA_1_DDL,
  MISSTAMPED_CURRENT_SHAPE_VERSION,
  PUBLISHED_SCHEMA_18_DDL,
  PUBLISHED_SCHEMA_18_VERSION,
  PUBLISHED_SCHEMA_19_DDL,
  PUBLISHED_SCHEMA_19_VERSION,
  SCHEMA_19_OUTBOX_DDL,
  SCHEMA_19_OUTBOX_STATUS_PROMOTION_DDL,
  SCHEMA_20_CHAPTER_PROCESSING_STATUS_DDL,
  SCHEMA_20_DDL,
  SCHEMA_20_VERSION,
  SCHEMA_21_CHAT_TURNS_DDL,
  currentSchemaSql,
} from '@/lib/db/schema';

const SCHEMA_VERSION_DDL = `
CREATE TABLE _schema_version (
  version     INTEGER NOT NULL,
  description TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);
`;

const PUBLISHED_USER_GUIDANCE =
  'Preserve a backup of your InkMarshal data directory, then update InkMarshal or contact support. ' +
  'Do not delete or reset the database to recover.';

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
    super(`InkMarshal local database is incompatible with this build: ${message} ${PUBLISHED_USER_GUIDANCE}`);
    this.name = 'IncompatibleDatabaseSchemaError';
  }
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

function assertIntegrity(db: Database.Database): void {
  const integrity = db.pragma('quick_check', { simple: true });
  if (integrity !== 'ok') {
    throw new IncompatibleDatabaseSchemaError(`SQLite quick_check returned ${String(integrity)}.`);
  }
}

function stampSchemaVersion(db: Database.Database, description: string): void {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT COUNT(*) AS count FROM _schema_version')
    .get() as { count: number };
  if (existing.count === 0) {
    db.prepare(
      'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
    ).run(CURRENT_SCHEMA_VERSION, description, now);
  } else if (existing.count === 1) {
    db.prepare(
      'UPDATE _schema_version SET version = ?, description = ?, applied_at = ?',
    ).run(CURRENT_SCHEMA_VERSION, description, now);
  } else {
    throw new IncompatibleDatabaseSchemaError('the schema marker is missing or ambiguous.');
  }
  db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
}

function buildReferenceFingerprint(
  baselineDdl: string,
  version: number,
  description: string,
): SchemaFingerprint {
  const db = new Database(':memory:');
  try {
    db.exec(baselineDdl);
    db.exec(SCHEMA_VERSION_DDL);
    db.prepare(
      'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
    ).run(version, description, '1970-01-01T00:00:00.000Z');
    db.pragma(`user_version = ${version}`);
    return computeSchemaFingerprint(db);
  } finally {
    db.close();
  }
}

let cachedPublished18Fingerprint: SchemaFingerprint | null = null;
let cachedLegacy1Fingerprint: SchemaFingerprint | null = null;
let cachedPublished19Fingerprint: SchemaFingerprint | null = null;
let cachedSchema20Fingerprint: SchemaFingerprint | null = null;
let cachedCurrentFingerprint: SchemaFingerprint | null = null;

export function publishedSchema18Fingerprint(): SchemaFingerprint {
  cachedPublished18Fingerprint ??= buildReferenceFingerprint(
    PUBLISHED_SCHEMA_18_DDL,
    PUBLISHED_SCHEMA_18_VERSION,
    'baseline_epoch_v18',
  );
  return cachedPublished18Fingerprint;
}

export function legacySchema1Fingerprint(): SchemaFingerprint {
  cachedLegacy1Fingerprint ??= buildReferenceFingerprint(
    LEGACY_SCHEMA_1_DDL,
    MISSTAMPED_CURRENT_SHAPE_VERSION,
    'current_prelaunch_baseline',
  );
  return cachedLegacy1Fingerprint;
}

export function publishedSchema19Fingerprint(): SchemaFingerprint {
  cachedPublished19Fingerprint ??= buildReferenceFingerprint(
    PUBLISHED_SCHEMA_19_DDL,
    PUBLISHED_SCHEMA_19_VERSION,
    'current_epoch_v19',
  );
  return cachedPublished19Fingerprint;
}

export function schema20Fingerprint(): SchemaFingerprint {
  cachedSchema20Fingerprint ??= buildReferenceFingerprint(
    SCHEMA_20_DDL,
    SCHEMA_20_VERSION,
    'current_epoch_v20',
  );
  return cachedSchema20Fingerprint;
}

export function currentSchemaFingerprint(): SchemaFingerprint {
  cachedCurrentFingerprint ??= buildReferenceFingerprint(
    currentSchemaSql,
    CURRENT_SCHEMA_VERSION,
    CURRENT_SCHEMA_DESCRIPTION,
  );
  return cachedCurrentFingerprint;
}

function fingerprintsMatch(actual: SchemaFingerprint, expected: SchemaFingerprint): boolean {
  return actual.digest === expected.digest
    && actual.userVersion === expected.userVersion
    && actual.objectCount === expected.objectCount;
}

/**
 * Create a verified snapshot of the live database next to it before a
 * migration touches published data. `VACUUM INTO` writes a consistent copy,
 * then the copy is reopened for `PRAGMA integrity_check`. Returns the backup
 * path, or null for in-memory databases. Throws if the snapshot cannot be
 * written or fails its integrity check.
 */
export function createVerifiedBackup(db: Database.Database, fromVersion: number): string | null {
  const dbPath = db.name;
  if (!dbPath || dbPath === ':memory:') return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.pre-migration-v${fromVersion}-${stamp}.bak`;
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

/** Read-only validation for a database already at the current epoch. */
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

  const actual = computeSchemaFingerprint(db);
  if (!fingerprintsMatch(actual, currentSchemaFingerprint())) {
    throw new IncompatibleDatabaseSchemaError(
      'the structural schema fingerprint does not match the current baseline.',
    );
  }
  assertIntegrity(db);
}

export type SchemaOpenPlan =
  | 'current'
  | 'schema18_to_21'
  | 'misstamped1_to_21'
  | 'schema19_to_21'
  | 'schema20_to_21';

/**
 * Read-only classification for an existing database. Throws without mutating
 * when the shape/version is unsupported. Safe to call on a readonly handle so
 * fail-closed paths never create WAL/SHM sidecars beside published data.
 */
export function inspectSchemaOpenPlan(db: Database.Database): SchemaOpenPlan {
  const version = recordedSchemaVersion(db);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new DatabaseFromNewerAppVersionError(version, CURRENT_SCHEMA_VERSION);
  }

  assertIntegrity(db);
  const actual = computeSchemaFingerprint(db);
  const pragmaUserVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);
  if (pragmaUserVersion !== version) {
    throw new IncompatibleDatabaseSchemaError(
      `PRAGMA user_version (${pragmaUserVersion}) does not match the schema marker (${version}).`,
    );
  }

  if (version === CURRENT_SCHEMA_VERSION) {
    if (!fingerprintsMatch(actual, currentSchemaFingerprint())) {
      throw new IncompatibleDatabaseSchemaError(
        'the structural schema fingerprint does not match the current baseline.',
      );
    }
    return 'current';
  }

  if (version === PUBLISHED_SCHEMA_18_VERSION) {
    if (!fingerprintsMatch(actual, publishedSchema18Fingerprint())) {
      throw new IncompatibleDatabaseSchemaError(
        'schema 18 structural fingerprint does not match the published v0.1.0/v0.1.1 shape.',
      );
    }
    return 'schema18_to_21';
  }

  if (version === MISSTAMPED_CURRENT_SHAPE_VERSION) {
    if (!fingerprintsMatch(actual, legacySchema1Fingerprint())) {
      throw new IncompatibleDatabaseSchemaError(
        'schema 1 structural fingerprint is not the already-distributed legacy outbox shape.',
      );
    }
    return 'misstamped1_to_21';
  }

  if (version === PUBLISHED_SCHEMA_19_VERSION) {
    if (!fingerprintsMatch(actual, publishedSchema19Fingerprint())) {
      throw new IncompatibleDatabaseSchemaError(
        'schema 19 structural fingerprint does not match the exact pre-lifecycle shape.',
      );
    }
    return 'schema19_to_21';
  }

  if (version === SCHEMA_20_VERSION) {
    if (!fingerprintsMatch(actual, schema20Fingerprint())) {
      throw new IncompatibleDatabaseSchemaError(
        'schema 20 structural fingerprint does not match the exact pre-chat-turns shape.',
      );
    }
    return 'schema20_to_21';
  }

  throw new IncompatibleDatabaseSchemaError(
    `found schema ${version}; only published schema ${PUBLISHED_SCHEMA_18_VERSION}, ` +
      `mis-stamped legacy-outbox schema ${MISSTAMPED_CURRENT_SHAPE_VERSION}, ` +
      `exact schema ${PUBLISHED_SCHEMA_19_VERSION}, ` +
      `exact schema ${SCHEMA_20_VERSION}, ` +
      `or current schema ${CURRENT_SCHEMA_VERSION} can be opened.`,
  );
}

function applyPromotion(
  db: Database.Database,
  kind: Exclude<SchemaOpenPlan, 'current'>,
): void {
  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    if (kind === 'schema18_to_21') {
      db.exec(SCHEMA_19_OUTBOX_DDL);
      db.exec(SCHEMA_20_CHAPTER_PROCESSING_STATUS_DDL);
      db.exec(SCHEMA_21_CHAT_TURNS_DDL);
    } else if (kind === 'misstamped1_to_21') {
      db.exec(SCHEMA_19_OUTBOX_STATUS_PROMOTION_DDL);
      db.exec(SCHEMA_20_CHAPTER_PROCESSING_STATUS_DDL);
      db.exec(SCHEMA_21_CHAT_TURNS_DDL);
    } else if (kind === 'schema19_to_21') {
      db.exec(SCHEMA_20_CHAPTER_PROCESSING_STATUS_DDL);
      db.exec(SCHEMA_21_CHAT_TURNS_DDL);
    } else {
      db.exec(SCHEMA_21_CHAT_TURNS_DDL);
    }
    stampSchemaVersion(db, CURRENT_SCHEMA_DESCRIPTION);
    db.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}

function fromVersionForPlan(kind: Exclude<SchemaOpenPlan, 'current'>): number {
  if (kind === 'schema18_to_21') return PUBLISHED_SCHEMA_18_VERSION;
  if (kind === 'misstamped1_to_21') return MISSTAMPED_CURRENT_SHAPE_VERSION;
  if (kind === 'schema19_to_21') return PUBLISHED_SCHEMA_19_VERSION;
  return SCHEMA_20_VERSION;
}

/**
 * Validate an existing nonempty database and, when it is an exact published
 * schema 18, exact legacy schema-1 outbox, exact schema 19, or exact schema 20
 * database, promote it transactionally to schema 21. Unknown legacy shapes and
 * future versions fail closed. Never reinterprets speculative intermediate versions.
 */
export function ensureCurrentSchema(
  db: Database.Database,
  backupFn: (db: Database.Database, fromVersion: number) => string | null = createVerifiedBackup,
): void {
  const kind = inspectSchemaOpenPlan(db);
  if (kind === 'current') {
    assertCurrentSchema(db);
    return;
  }

  const fromVersion = fromVersionForPlan(kind);

  // Additive promotion: a backup failure warns and proceeds so a backup-dir
  // hiccup cannot wedge startup on published user data. Destructive steps are
  // not part of this epoch jump.
  try {
    backupFn(db, fromVersion);
  } catch (error) {
    console.warn(
      `[migrations] pre-migration backup failed (proceeding: additive schema ${fromVersion}→${CURRENT_SCHEMA_VERSION}): ${(error as Error).message}`,
    );
  }

  applyPromotion(db, kind);
  assertCurrentSchema(db);
}

/** Initialize one empty database directly at the current product shape. */
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
    ).run(CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_DESCRIPTION, new Date().toISOString());
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
