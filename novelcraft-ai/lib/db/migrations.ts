import Database from 'better-sqlite3';
import { renameSync, rmSync } from 'node:fs';

import {
  computeSchemaFingerprint,
  computeSqliteSchemaSqlOracle,
  type SchemaFingerprint,
} from '@/lib/db/schema-fingerprint';
import {
  CURRENT_SCHEMA_DESCRIPTION,
  CURRENT_SCHEMA_VERSION,
  KNOWN_LEGACY_REVIEW_ITEMS_DDL,
  KNOWN_LEGACY_REVIEW_ITEMS_MARKERS,
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

/** Stable, non-secret API codes for authenticated desktop database failures. */
const LOCAL_DATABASE_ERROR_CODES = {
  BACKUP_REQUIRED: 'DATABASE_BACKUP_REQUIRED',
  INCOMPATIBLE: 'DATABASE_INCOMPATIBLE',
  NEWER_VERSION: 'DATABASE_NEWER_VERSION',
  UNAVAILABLE: 'DATABASE_UNAVAILABLE',
} as const;

export type LocalDatabaseErrorCode =
  (typeof LOCAL_DATABASE_ERROR_CODES)[keyof typeof LOCAL_DATABASE_ERROR_CODES];

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

export class PreMigrationBackupRequiredError extends Error {
  constructor(message: string) {
    super(
      `InkMarshal refused a destructive database recovery because a verified pre-migration ` +
        `backup could not be created: ${message}`,
    );
    this.name = 'PreMigrationBackupRequiredError';
  }
}

export class LocalDatabaseUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LocalDatabaseUnavailableError';
  }
}

interface SchemaMarkerRow {
  version: number;
  description: string;
}

function readSchemaMarkerRows(db: Database.Database): SchemaMarkerRow[] | null {
  const hasVersionTable = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_schema_version'")
    .get() as { present: number } | undefined;
  if (!hasVersionTable) return null;
  return db
    .prepare('SELECT version, description FROM _schema_version ORDER BY version DESC')
    .all() as SchemaMarkerRow[];
}

function recordedSchemaVersion(db: Database.Database): number {
  const rows = readSchemaMarkerRows(db);
  if (!rows) {
    throw new IncompatibleDatabaseSchemaError('the nonempty database has no schema marker.');
  }
  if (rows.length !== 1 || !Number.isInteger(rows[0]!.version)) {
    throw new IncompatibleDatabaseSchemaError('the schema marker is missing or ambiguous.');
  }
  return rows[0]!.version;
}

function isKnownLegacyReviewItemsMarkerHistory(rows: SchemaMarkerRow[]): boolean {
  if (rows.length !== KNOWN_LEGACY_REVIEW_ITEMS_MARKERS.length) return false;
  // Fingerprint and recognition both order by version DESC: 18 then 1.
  const expected = [...KNOWN_LEGACY_REVIEW_ITEMS_MARKERS]
    .sort((a, b) => b.version - a.version);
  return rows.every((row, index) => (
    row.version === expected[index]!.version
    && row.description === expected[index]!.description
  ));
}

function assertIntegrity(db: Database.Database): void {
  const integrity = db.pragma('quick_check', { simple: true });
  if (integrity !== 'ok') {
    throw new IncompatibleDatabaseSchemaError(`SQLite quick_check returned ${String(integrity)}.`);
  }
}

function stampSchemaVersion(
  db: Database.Database,
  description: string,
  normalizeKnownDualMarkers = false,
): void {
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
  } else if (normalizeKnownDualMarkers && existing.count === 2) {
    db.prepare('DELETE FROM _schema_version').run();
    db.prepare(
      'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
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

function buildKnownLegacyReviewItemsFingerprint(): SchemaFingerprint {
  const db = new Database(':memory:');
  try {
    db.exec(PUBLISHED_SCHEMA_18_DDL);
    db.exec(KNOWN_LEGACY_REVIEW_ITEMS_DDL);
    db.exec(SCHEMA_VERSION_DDL);
    const insert = db.prepare(
      'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
    );
    for (const marker of KNOWN_LEGACY_REVIEW_ITEMS_MARKERS) {
      insert.run(marker.version, marker.description, '1970-01-01T00:00:00.000Z');
    }
    db.pragma(`user_version = ${PUBLISHED_SCHEMA_18_VERSION}`);
    return computeSchemaFingerprint(db);
  } finally {
    db.close();
  }
}

let cachedPublished18Fingerprint: SchemaFingerprint | null = null;
let cachedLegacy1Fingerprint: SchemaFingerprint | null = null;
let cachedPublished19Fingerprint: SchemaFingerprint | null = null;
let cachedSchema20Fingerprint: SchemaFingerprint | null = null;
let cachedKnownLegacyReviewItemsFingerprint: SchemaFingerprint | null = null;
let cachedKnownLegacyReviewItemsSqlOracle: ReturnType<typeof computeSqliteSchemaSqlOracle> | null = null;
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

export function knownLegacyReviewItemsFingerprint(): SchemaFingerprint {
  cachedKnownLegacyReviewItemsFingerprint ??= buildKnownLegacyReviewItemsFingerprint();
  return cachedKnownLegacyReviewItemsFingerprint;
}

function knownLegacyReviewItemsSqlOracle(): ReturnType<typeof computeSqliteSchemaSqlOracle> {
  if (cachedKnownLegacyReviewItemsSqlOracle) return cachedKnownLegacyReviewItemsSqlOracle;
  const db = new Database(':memory:');
  try {
    db.exec(PUBLISHED_SCHEMA_18_DDL);
    db.exec(KNOWN_LEGACY_REVIEW_ITEMS_DDL);
    db.exec(SCHEMA_VERSION_DDL);
    cachedKnownLegacyReviewItemsSqlOracle = computeSqliteSchemaSqlOracle(db);
    return cachedKnownLegacyReviewItemsSqlOracle;
  } finally {
    db.close();
  }
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
  const temporaryPath = `${backupPath}.tmp`;

  let backup: Database.Database | undefined;
  try {
    db.exec(`VACUUM INTO '${temporaryPath.replace(/'/g, "''")}'`);
    backup = new Database(temporaryPath, { readonly: true });
    const result = backup.pragma('integrity_check', { simple: true });
    if (result !== 'ok') {
      throw new Error(`integrity_check on the pre-migration backup returned "${String(result)}"`);
    }
    backup.close();
    backup = undefined;
    renameSync(temporaryPath, backupPath);
    return backupPath;
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  } finally {
    backup?.close();
  }
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
  | 'schema20_to_21'
  | 'known_legacy_review_items_to_21';

/**
 * Read-only classification for an existing database. Throws without mutating
 * when the shape/version is unsupported. Safe to call on a readonly handle so
 * fail-closed paths never create WAL/SHM sidecars beside published data.
 */
export function inspectSchemaOpenPlan(db: Database.Database): SchemaOpenPlan {
  const markers = readSchemaMarkerRows(db);
  if (!markers) {
    throw new IncompatibleDatabaseSchemaError('the nonempty database has no schema marker.');
  }
  if (markers.length === 0 || markers.some(row => !Number.isInteger(row.version))) {
    throw new IncompatibleDatabaseSchemaError('the schema marker is missing or ambiguous.');
  }

  const highestVersion = Math.max(...markers.map(row => row.version));
  if (highestVersion > CURRENT_SCHEMA_VERSION) {
    throw new DatabaseFromNewerAppVersionError(highestVersion, CURRENT_SCHEMA_VERSION);
  }

  assertIntegrity(db);
  const actual = computeSchemaFingerprint(db);
  const pragmaUserVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);

  if (isKnownLegacyReviewItemsMarkerHistory(markers)) {
    if (pragmaUserVersion !== PUBLISHED_SCHEMA_18_VERSION) {
      throw new IncompatibleDatabaseSchemaError(
        `PRAGMA user_version (${pragmaUserVersion}) does not match the known legacy marker (${PUBLISHED_SCHEMA_18_VERSION}).`,
      );
    }
    if (!fingerprintsMatch(actual, knownLegacyReviewItemsFingerprint())) {
      throw new IncompatibleDatabaseSchemaError(
        'known legacy review_items structural fingerprint does not match the exact recovery shape.',
      );
    }
    const actualSqlOracle = computeSqliteSchemaSqlOracle(db);
    const expectedSqlOracle = knownLegacyReviewItemsSqlOracle();
    if (
      actualSqlOracle.digest !== expectedSqlOracle.digest
      || actualSqlOracle.objectCount !== expectedSqlOracle.objectCount
    ) {
      throw new IncompatibleDatabaseSchemaError(
        'known legacy review_items SQL oracle does not match the exact recovery shape.',
      );
    }
    const legacyRows = db
      .prepare('SELECT COUNT(*) AS count FROM review_items')
      .get() as { count: number };
    if (legacyRows.count !== 0) {
      throw new IncompatibleDatabaseSchemaError(
        'the obsolete review_items table contains data and cannot be discarded automatically.',
      );
    }
    return 'known_legacy_review_items_to_21';
  }

  if (markers.length !== 1) {
    throw new IncompatibleDatabaseSchemaError('the schema marker is missing or ambiguous.');
  }

  const version = markers[0]!.version;
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
      `the known dual-marker review_items legacy shape, ` +
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
    if (kind === 'known_legacy_review_items_to_21') {
      const revalidatedKind = inspectSchemaOpenPlan(db);
      if (revalidatedKind !== kind) {
        throw new IncompatibleDatabaseSchemaError(
          'the known legacy database changed before its recovery transaction began.',
        );
      }
    }
    if (kind === 'schema18_to_21') {
      db.exec(SCHEMA_19_OUTBOX_DDL);
      db.exec(SCHEMA_20_CHAPTER_PROCESSING_STATUS_DDL);
      db.exec(SCHEMA_21_CHAT_TURNS_DDL);
    } else if (kind === 'known_legacy_review_items_to_21') {
      db.exec(SCHEMA_19_OUTBOX_DDL);
      db.exec(SCHEMA_20_CHAPTER_PROCESSING_STATUS_DDL);
      db.exec(SCHEMA_21_CHAT_TURNS_DDL);
      // Obsolete feature table: no current owner. Drop only after additive
      // structures land in the same transaction.
      db.exec('DROP TABLE IF EXISTS review_items');
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
    stampSchemaVersion(
      db,
      CURRENT_SCHEMA_DESCRIPTION,
      kind === 'known_legacy_review_items_to_21',
    );
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
  if (kind === 'schema18_to_21' || kind === 'known_legacy_review_items_to_21') {
    return PUBLISHED_SCHEMA_18_VERSION;
  }
  if (kind === 'misstamped1_to_21') return MISSTAMPED_CURRENT_SHAPE_VERSION;
  if (kind === 'schema19_to_21') return PUBLISHED_SCHEMA_19_VERSION;
  return SCHEMA_20_VERSION;
}

function requireVerifiedBackup(
  db: Database.Database,
  fromVersion: number,
  backupFn: (db: Database.Database, fromVersion: number) => string | null,
): void {
  let backupPath: string | null;
  try {
    backupPath = backupFn(db, fromVersion);
  } catch (error) {
    throw new PreMigrationBackupRequiredError((error as Error).message);
  }
  const dbPath = db.name;
  if (dbPath && dbPath !== ':memory:' && !backupPath) {
    throw new PreMigrationBackupRequiredError('backup path was not produced for an on-disk database.');
  }
}

/**
 * Validate an existing nonempty database and, when it is an exact published
 * schema 18, exact known dual-marker review_items legacy shape, exact legacy
 * schema-1 outbox, exact schema 19, or exact schema 20 database, promote it
 * transactionally to schema 21. Unknown legacy shapes and future versions fail
 * closed. Never reinterprets speculative intermediate versions.
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

  if (kind === 'known_legacy_review_items_to_21') {
    // The obsolete table is empty, but its removal is still guarded by a
    // verified snapshot. Backup failure aborts before the migration transaction.
    requireVerifiedBackup(db, fromVersion, backupFn);
  } else {
    // Additive promotion: a backup failure warns and proceeds so a backup-dir
    // hiccup cannot wedge startup on published user data.
    try {
      backupFn(db, fromVersion);
    } catch (error) {
      console.warn(
        `[migrations] pre-migration backup failed (proceeding: additive schema ${fromVersion}→${CURRENT_SCHEMA_VERSION}): ${(error as Error).message}`,
      );
    }
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

/**
 * Map typed local-database failures to stable API payloads. Never includes
 * filesystem paths or internal diagnostics in the client-visible body.
 */
export function mapLocalDatabaseApiError(error: unknown): {
  status: number;
  code: LocalDatabaseErrorCode;
  error: string;
} | null {
  if (error instanceof DatabaseFromNewerAppVersionError) {
    return {
      status: 503,
      code: LOCAL_DATABASE_ERROR_CODES.NEWER_VERSION,
      error: 'Local database was created by a newer InkMarshal version. Update InkMarshal before opening this library.',
    };
  }
  if (error instanceof PreMigrationBackupRequiredError) {
    return {
      status: 503,
      code: LOCAL_DATABASE_ERROR_CODES.BACKUP_REQUIRED,
      error: 'InkMarshal did not change the local database because a safety backup could not be created. Free disk space, check folder permissions, and retry.',
    };
  }
  if (error instanceof IncompatibleDatabaseSchemaError) {
    return {
      status: 503,
      code: LOCAL_DATABASE_ERROR_CODES.INCOMPATIBLE,
      error: 'Local database is incompatible with this InkMarshal build. Preserve a backup and contact support; do not delete the database.',
    };
  }
  if (error instanceof LocalDatabaseUnavailableError) {
    return {
      status: 503,
      code: LOCAL_DATABASE_ERROR_CODES.UNAVAILABLE,
      error: 'Local database could not be opened. Preserve a backup and restart InkMarshal, or contact support.',
    };
  }
  return null;
}
