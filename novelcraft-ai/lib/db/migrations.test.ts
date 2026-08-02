import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDbForTest,
  getDb,
  inspectExistingDatabaseWithoutTouchingSource,
} from '@/lib/db/connection';
import {
  assertCurrentSchema,
  createVerifiedBackup,
  DatabaseFromNewerAppVersionError,
  IncompatibleDatabaseSchemaError,
  LocalDatabaseUnavailableError,
  ensureCurrentSchema,
  initializeCurrentSchema,
  knownLegacyReviewItemsFingerprint,
  legacySchema1Fingerprint,
  publishedSchema18Fingerprint,
  publishedSchema19Fingerprint,
  currentSchemaFingerprint,
  schema20Fingerprint,
  schema21Fingerprint,
} from '@/lib/db/migrations';
import {
  computeSchemaFingerprint,
  computeSqliteSchemaSqlOracle,
} from '@/lib/db/schema-fingerprint';
import {
  CURRENT_SCHEMA_TABLES,
  CURRENT_SCHEMA_VERSION,
  KNOWN_LEGACY_REVIEW_ITEMS_DDL,
  KNOWN_LEGACY_REVIEW_ITEMS_MARKERS,
  LEGACY_SCHEMA_1_DDL,
  LEGACY_SCHEMA_1_SQL_ORACLE,
  LEGACY_SCHEMA_1_SQL_ORACLE_OBJECT_COUNT,
  PUBLISHED_SCHEMA_18_DDL,
  PUBLISHED_SCHEMA_18_SQL_ORACLE,
  PUBLISHED_SCHEMA_18_SQL_ORACLE_OBJECT_COUNT,
  PUBLISHED_SCHEMA_18_TABLES,
  PUBLISHED_SCHEMA_18_VERSION,
  PUBLISHED_SCHEMA_19_DDL,
  PUBLISHED_SCHEMA_19_VERSION,
  SCHEMA_19_OUTBOX_DDL,
  SCHEMA_20_CHAPTER_PROCESSING_STATUS_DDL,
  SCHEMA_20_DDL,
  SCHEMA_20_VERSION,
  SCHEMA_21_CHAT_TURNS_DDL,
  SCHEMA_21_DDL,
  SCHEMA_21_VERSION,
  SCHEMA_22_MIRROR_CONTENT_HASH_DDL,
  currentSchemaSql,
} from '@/lib/db/schema';

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let dataDir: string;

function dbPath(): string {
  return path.join(dataDir, 'inkmarshal.db');
}

function tables(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(row => (row as { name: string }).name)
    .filter(name => !name.startsWith('sqlite_'));
}

function digest(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function databaseFileState(): Record<string, string> {
  const base = dbPath();
  return Object.fromEntries(
    [base, `${base}-wal`, `${base}-shm`]
      .filter(existsSync)
      .map(filePath => [path.basename(filePath), digest(filePath)]),
  );
}

function stampVersion(db: Database.Database, version: number, description: string): void {
  // Match the release-oracle marker DDL exactly (no IF NOT EXISTS) so SQL
  // evidence hashes stay stable against the frozen tagged baseline.
  db.exec(
    'CREATE TABLE _schema_version (version INTEGER NOT NULL, description TEXT NOT NULL, applied_at TEXT NOT NULL);',
  );
  db.prepare(
    'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
  ).run(version, description, '2026-07-01T00:00:00.000Z');
  db.pragma(`user_version = ${version}`);
}

/** Exact published v0.1.0/v0.1.1 shape from frozen tagged DDL. */
function seedPublishedSchema18(db: Database.Database): void {
  expect(PUBLISHED_SCHEMA_18_DDL).not.toContain('knowledge_vault_outbox');
  expect(SCHEMA_19_OUTBOX_DDL).toContain('knowledge_vault_outbox');
  db.exec(PUBLISHED_SCHEMA_18_DDL);
  stampVersion(db, PUBLISHED_SCHEMA_18_VERSION, 'baseline_epoch_v18');
}

/** Already-distributed mis-stamped legacy outbox shape (no status column, version 1). */
function seedMisstampedLegacyOutbox(db: Database.Database): void {
  expect(LEGACY_SCHEMA_1_DDL).toContain('knowledge_vault_outbox');
  expect(LEGACY_SCHEMA_1_DDL).not.toMatch(
    /knowledge_vault_outbox \([\s\S]*?status\s+TEXT NOT NULL DEFAULT 'pending'/,
  );
  db.exec(LEGACY_SCHEMA_1_DDL);
  stampVersion(db, 1, 'current_prelaunch_baseline');
}

/** Exact schema-19 shape (outbox present; chapters lack processing_status). */
function seedPublishedSchema19(db: Database.Database): void {
  expect(PUBLISHED_SCHEMA_19_DDL).toContain('knowledge_vault_outbox');
  expect(PUBLISHED_SCHEMA_19_DDL).not.toContain('processing_status');
  expect(SCHEMA_20_CHAPTER_PROCESSING_STATUS_DDL).toContain('processing_status');
  db.exec(PUBLISHED_SCHEMA_19_DDL);
  stampVersion(db, PUBLISHED_SCHEMA_19_VERSION, 'current_epoch_v19');
}

/** Exact schema-20 shape (processing_status present; no chat_turns). */
function seedSchema20(db: Database.Database): void {
  expect(SCHEMA_20_DDL).toContain('processing_status');
  expect(SCHEMA_20_DDL).not.toContain('chat_turns');
  expect(SCHEMA_21_CHAT_TURNS_DDL).toContain('chat_turns');
  db.exec(SCHEMA_20_DDL);
  stampVersion(db, SCHEMA_20_VERSION, 'current_epoch_v20');
}

/** Exact schema-21 shape (chat_turns present; no mirror_content_hash). */
function seedSchema21(db: Database.Database): void {
  expect(SCHEMA_21_DDL).toContain('chat_turns');
  expect(SCHEMA_21_DDL).not.toContain('mirror_content_hash');
  expect(SCHEMA_22_MIRROR_CONTENT_HASH_DDL).toContain('mirror_content_hash');
  db.exec(SCHEMA_21_DDL);
  stampVersion(db, SCHEMA_21_VERSION, 'current_epoch_v21');
}


/** Schema-only known dual-marker legacy: published-18 + obsolete review_items. */
function seedKnownLegacyReviewItems(db: Database.Database): void {
  expect(PUBLISHED_SCHEMA_18_DDL).not.toContain('review_items');
  expect(KNOWN_LEGACY_REVIEW_ITEMS_DDL).toContain('CREATE TABLE review_items');
  db.exec(PUBLISHED_SCHEMA_18_DDL);
  db.exec(KNOWN_LEGACY_REVIEW_ITEMS_DDL);
  db.exec(`
CREATE TABLE _schema_version (
  version     INTEGER NOT NULL,
  description TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);
`);
  const insert = db.prepare(
    'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
  );
  for (const marker of KNOWN_LEGACY_REVIEW_ITEMS_MARKERS) {
    insert.run(marker.version, marker.description, '2026-07-01T00:00:00.000Z');
  }
  db.pragma(`user_version = ${PUBLISHED_SCHEMA_18_VERSION}`);
}


beforeEach(() => {
  closeDbForTest();
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-schema-epoch-'));
  process.env.INKMARSHAL_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDbForTest();
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('release-oracle schema fingerprints', () => {
  it('freezes published-18 and legacy-1 SQL oracles from exact DDL', () => {
    const pub = new Database(':memory:');
    seedPublishedSchema18(pub);
    const pubOracle = computeSqliteSchemaSqlOracle(pub);
    expect(pubOracle.objectCount).toBe(PUBLISHED_SCHEMA_18_SQL_ORACLE_OBJECT_COUNT);
    expect(pubOracle.digest).toBe(PUBLISHED_SCHEMA_18_SQL_ORACLE);
    expect(computeSchemaFingerprint(pub).digest).toBe(publishedSchema18Fingerprint().digest);
    pub.close();

    const legacy = new Database(':memory:');
    seedMisstampedLegacyOutbox(legacy);
    const legacyOracle = computeSqliteSchemaSqlOracle(legacy);
    expect(legacyOracle.objectCount).toBe(LEGACY_SCHEMA_1_SQL_ORACLE_OBJECT_COUNT);
    expect(legacyOracle.digest).toBe(LEGACY_SCHEMA_1_SQL_ORACLE);
    expect(computeSchemaFingerprint(legacy).digest).toBe(legacySchema1Fingerprint().digest);
    legacy.close();

    const schema19 = new Database(':memory:');
    seedPublishedSchema19(schema19);
    expect(computeSchemaFingerprint(schema19).digest).toBe(publishedSchema19Fingerprint().digest);
    schema19.close();

    const schema20 = new Database(':memory:');
    seedSchema20(schema20);
    expect(computeSchemaFingerprint(schema20).digest).toBe(schema20Fingerprint().digest);
    schema20.close();

    const schema21 = new Database(':memory:');
    seedSchema21(schema21);
    expect(computeSchemaFingerprint(schema21).digest).toBe(schema21Fingerprint().digest);
    schema21.close();

    const current = new Database(':memory:');
    initializeCurrentSchema(current);
    expect(computeSchemaFingerprint(current).digest).toBe(currentSchemaFingerprint().digest);
    current.close();
  });

  it('distinguishes inline UNIQUE constraints hidden in SQLite autoindexes', () => {
    const constrained = new Database(':memory:');
    constrained.exec(
      'CREATE TABLE demo (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT);',
    );
    const unconstrained = new Database(':memory:');
    unconstrained.exec(
      'CREATE TABLE demo (id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT);',
    );

    expect(computeSchemaFingerprint(constrained).digest)
      .not.toBe(computeSchemaFingerprint(unconstrained).digest);
    constrained.close();
    unconstrained.close();
  });
});

describe('current schema epoch 22', () => {
  it('initializes a fresh database at schema 22 with chat_turns and chapter processing_status', () => {
    const db = getDb();
    expect(CURRENT_SCHEMA_VERSION).toBe(22);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(tables(db)).toEqual([...CURRENT_SCHEMA_TABLES]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM _schema_version').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM prompt_templates').get() as { count: number }).count)
      .toBeGreaterThan(0);
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_vault_outbox'").get(),
    ).toMatchObject({ sql: expect.stringContaining("status") });
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chapters'").get(),
    ).toMatchObject({ sql: expect.stringContaining('processing_status') });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get(),
    ).toEqual({ name: 'chat_turns' });
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turn_tool_snapshots'",
      ).get(),
    ).toEqual({ name: 'chat_turn_tool_snapshots' });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_confirmations'").get(),
    ).toEqual({ name: 'import_confirmations' });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brainstorm_receipts'").get(),
    ).toEqual({ name: 'brainstorm_receipts' });
    expect(
      db.prepare('PRAGMA table_info(knowledge_index)').all() as Array<{ name: string }>,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mirror_content_hash' }),
    ]));
  });

  it('opens a current-schema database without DDL and idempotently provisions seed rows', () => {
    const setup = new Database(dbPath());
    initializeCurrentSchema(setup);
    setup.close();

    const db = getDb();
    expect(() => assertCurrentSchema(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM _schema_version').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
  });

  it('restores a missing seed row on reopen without overwriting an existing row', () => {
    const first = getDb();
    first.prepare('DELETE FROM prompt_templates WHERE id = ?').run('pt_unification_user_en_1');
    first.prepare(
      'UPDATE prompt_templates SET version = ?, template_text = ? WHERE id = ?',
    ).run(42, 'CUSTOM KEEP', 'pt_unification_user_zhCN_1');
    closeDbForTest();

    const reopened = getDb();
    expect(
      reopened.prepare(
        'SELECT version, template_text AS templateText FROM prompt_templates WHERE id = ?',
      ).get('pt_unification_user_en_1'),
    ).toMatchObject({ version: 1 });
    expect(
      reopened.prepare(
        'SELECT version, template_text AS templateText FROM prompt_templates WHERE id = ?',
      ).get('pt_unification_user_zhCN_1'),
    ).toEqual({ version: 42, templateText: 'CUSTOM KEEP' });
  });

  it('rolls back a failed first-run bootstrap instead of leaving a partial schema', () => {
    const db = new Database(':memory:');
    expect(() => initializeCurrentSchema(db, () => {
      throw new Error('seed failed');
    })).toThrow('seed failed');
    expect(tables(db)).toEqual([]);
    db.close();
  });
});

describe('published schema 18 → 22', () => {
  it('migrates transactionally, preserves rows, and creates a verified backup', () => {
    const setup = new Database(dbPath());
    seedPublishedSchema18(setup);
    expect(tables(setup)).toEqual([...PUBLISHED_SCHEMA_18_TABLES]);
    const now = new Date().toISOString();
    setup.prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u@test', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'Shipped Book', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES ('c1', 'n1', 1, 'One', 'Body', 1, 0, ?)`,
    ).run(now);
    setup.close();

    const db = getDb();
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(tables(db)).toEqual([...CURRENT_SCHEMA_TABLES]);
    expect(db.prepare('SELECT title FROM novels WHERE id = ?').get('n1')).toEqual({ title: 'Shipped Book' });
    expect(db.prepare('SELECT title FROM chapters WHERE id = ?').get('c1')).toEqual({ title: 'One' });
    expect(db.prepare('SELECT processing_status FROM chapters WHERE id = ?').get('c1')).toEqual({
      processing_status: 'complete',
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_vault_outbox'").get(),
    ).toEqual({ name: 'knowledge_vault_outbox' });
    expect(
      db.prepare('PRAGMA table_info(knowledge_vault_outbox)').all() as Array<{ name: string }>,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'status' }),
      expect.objectContaining({ name: 'intent_revision' }),
    ]));
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get(),
    ).toEqual({ name: 'chat_turns' });
    expect(
      db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turn_tool_snapshots'",
      ).get(),
    ).toEqual({ name: 'chat_turn_tool_snapshots' });

    const backups = readdirSync(dataDir).filter(name => name.includes('.pre-migration-v18-') && name.endsWith('.bak'));
    expect(backups.length).toBe(1);
    expect(existsSync(path.join(dataDir, backups[0]!))).toBe(true);
  });

  it('rolls back a failed schema-18 promotion and preserves published rows', () => {
    const db = new Database(':memory:');
    seedPublishedSchema18(db);
    db.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'Keep', '', '')`,
    ).run();

    const boom = new Error('forced ddl failure');
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('knowledge_vault_outbox')) throw boom;
      return exec(sql);
    });

    expect(() => ensureCurrentSchema(db, () => null)).toThrow('forced ddl failure');
    expect(tables(db)).toEqual([...PUBLISHED_SCHEMA_18_TABLES]);
    expect(db.prepare('SELECT version FROM _schema_version').get()).toEqual({ version: 18 });
    expect(db.prepare('SELECT title FROM novels WHERE id = ?').get('n1')).toEqual({ title: 'Keep' });
    db.close();
  });

  it('warns and proceeds when pre-migration backup fails for additive 18→22', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = new Database(':memory:');
    seedPublishedSchema18(db);
    ensureCurrentSchema(db, () => {
      throw new Error('disk full');
    });
    expect(tables(db)).toEqual([...CURRENT_SCHEMA_TABLES]);
    expect(db.prepare('SELECT version FROM _schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pre-migration backup failed'));
    db.close();
    warn.mockRestore();
  });
});

describe('mis-stamped schema 1 legacy-outbox → 22', () => {
  it('promotes with status backfill, preserves rows, and creates a verified backup', () => {
    const setup = new Database(dbPath());
    seedMisstampedLegacyOutbox(setup);
    const now = new Date().toISOString();
    const earlier = '2026-01-01T00:00:00.000Z';
    setup.prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u@test', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'Interim Book', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO knowledge_vault_outbox
         (entry_id, novel_id, operation, rel_path, attempt_count, last_error, created_at, updated_at)
       VALUES ('e1', 'n1', 'upsert', 'characters/e1.md', 2, 'offline', ?, ?)`,
    ).run(now, now);
    // Ambiguous legacy delete: it may be a completed tombstone, or a delete
    // that replaced an upsert immediately before a crash.
    setup.prepare(
      `INSERT INTO knowledge_vault_outbox
         (entry_id, novel_id, operation, rel_path, attempt_count, last_error, created_at, updated_at)
       VALUES ('e2', 'n1', 'delete', 'characters/e2.md', 0, NULL, ?, ?)`,
    ).run(earlier, now);
    setup.close();

    const db = getDb();
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(tables(db)).toEqual([...CURRENT_SCHEMA_TABLES]);
    expect(db.prepare('SELECT title FROM novels WHERE id = ?').get('n1')).toEqual({ title: 'Interim Book' });
    expect(
      db.prepare('SELECT status, intent_revision, attempt_count, last_error FROM knowledge_vault_outbox WHERE entry_id = ?').get('e1'),
    ).toEqual({ status: 'pending', intent_revision: 1, attempt_count: 2, last_error: 'offline' });
    expect(
      db.prepare('SELECT status, intent_revision FROM knowledge_vault_outbox WHERE entry_id = ?').get('e2'),
    ).toEqual({ status: 'pending', intent_revision: 1 });

    const backups = readdirSync(dataDir).filter(name => name.includes('.pre-migration-v1-') && name.endsWith('.bak'));
    expect(backups.length).toBe(1);
  });
});


describe('published schema 19 → 22', () => {
  it('adds processing_status, defaults existing rows to complete, and preserves chapter prose', () => {
    const setup = new Database(dbPath());
    seedPublishedSchema19(setup);
    const now = new Date().toISOString();
    setup.prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u@test', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'Schema19 Book', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, summary, created_at)
       VALUES ('c1', 'n1', 1, 'One', 'Body from schema 19', 4, 0, '', ?)`,
    ).run(now);
    setup.close();

    const db = getDb();
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare('SELECT content, processing_status FROM chapters WHERE id = ?').get('c1')).toEqual({
      content: 'Body from schema 19',
      processing_status: 'complete',
    });
    const backups = readdirSync(dataDir).filter(name => name.includes('.pre-migration-v19-') && name.endsWith('.bak'));
    expect(backups.length).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get(),
    ).toEqual({ name: 'chat_turns' });
  });
});

describe('schema 20 → 22', () => {
  it('adds chat_turns, preserves chapter processing_status, and creates a verified backup', () => {
    const setup = new Database(dbPath());
    seedSchema20(setup);
    const now = new Date().toISOString();
    setup.prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u@test', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'Schema20 Book', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, summary, processing_status, created_at)
       VALUES ('c1', 'n1', 1, 'One', 'Body from schema 20', 4, 0, '', 'content_saved', ?)`,
    ).run(now);
    setup.close();

    const db = getDb();
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare('SELECT content, processing_status FROM chapters WHERE id = ?').get('c1')).toEqual({
      content: 'Body from schema 20',
      processing_status: 'content_saved',
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get(),
    ).toEqual({ name: 'chat_turns' });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'import_confirmations'").get(),
    ).toEqual({ name: 'import_confirmations' });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brainstorm_receipts'").get(),
    ).toEqual({ name: 'brainstorm_receipts' });
    const backups = readdirSync(dataDir).filter(name => name.includes('.pre-migration-v20-') && name.endsWith('.bak'));
    expect(backups.length).toBe(1);
  });
});


describe('schema 21 → 22', () => {
  it('adds mirror_content_hash, preserves chat_turns, and creates a verified backup', () => {
    const setup = new Database(dbPath());
    seedSchema21(setup);
    const now = new Date().toISOString();
    setup.prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u@test', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'Schema21 Book', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO knowledge_index
         (id, novel_id, type, path, title, tags, aliases, importance, data, outgoing_links, content_hash, updated_at)
       VALUES ('e1', 'n1', 'character', 'characters/e1.md', 'Hero', '[]', '[]', NULL, '{}', '[]', 'abc', ?)`,
    ).run(now);
    setup.close();

    const db = getDb();
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      db.prepare('PRAGMA table_info(knowledge_index)').all() as Array<{ name: string }>,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'mirror_content_hash' }),
    ]));
    expect(db.prepare('SELECT content_hash, mirror_content_hash FROM knowledge_index WHERE id = ?').get('e1')).toEqual({
      content_hash: 'abc',
      mirror_content_hash: null,
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get(),
    ).toEqual({ name: 'chat_turns' });
    const backups = readdirSync(dataDir).filter(name => name.includes('.pre-migration-v21-') && name.endsWith('.bak'));
    expect(backups.length).toBe(1);
  });
});

describe('known dual-marker review_items legacy → 22', () => {
  it('migrates an exact empty review_items legacy shape and preserves supported rows', () => {
    const setup = new Database(dbPath());
    seedKnownLegacyReviewItems(setup);
    expect(computeSchemaFingerprint(setup).digest).toBe(knownLegacyReviewItemsFingerprint().digest);
    const now = new Date().toISOString();
    setup.prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u@test', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'Legacy Recovery Book', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO chapters
         (id, novel_id, chapter_number, title, content, word_count, version, created_at)
       VALUES ('c1', 'n1', 1, 'One', 'Preserved body', 2, 0, ?)`,
    ).run(now);
    setup.close();

    const db = getDb();
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(tables(db)).toEqual([...CURRENT_SCHEMA_TABLES]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM _schema_version').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT version, description FROM _schema_version').get()).toEqual({
      version: CURRENT_SCHEMA_VERSION,
      description: `current_epoch_v${CURRENT_SCHEMA_VERSION}`,
    });
    expect(db.prepare('SELECT title FROM novels WHERE id = ?').get('n1')).toEqual({
      title: 'Legacy Recovery Book',
    });
    expect(db.prepare('SELECT content, processing_status FROM chapters WHERE id = ?').get('c1')).toEqual({
      content: 'Preserved body',
      processing_status: 'complete',
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_items'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get(),
    ).toEqual({ name: 'chat_turns' });

    const backups = readdirSync(dataDir).filter(name => name.includes('.pre-migration-v18-') && name.endsWith('.bak'));
    expect(backups.length).toBe(1);
    const backup = new Database(path.join(dataDir, backups[0]!), { readonly: true });
    expect(backup.prepare('SELECT COUNT(*) AS count FROM review_items').get()).toEqual({ count: 0 });
    backup.close();
  });

  it('refuses to discard nonempty review_items data and leaves the database unchanged', () => {
    const setup = new Database(dbPath());
    seedKnownLegacyReviewItems(setup);
    const now = new Date().toISOString();
    setup.prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u@test', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'Legacy Review Data', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO review_items
         (id, novel_id, source, severity, status, created_at, updated_at)
       VALUES ('r1', 'n1', 'author_todo', 'minor', 'open', ?, ?)`,
    ).run(now, now);
    setup.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(/review_items table contains data/);
    expect(digest(dbPath())).toBe(before);
    expect(readdirSync(dataDir).filter(name => name.endsWith('.bak'))).toHaveLength(0);

    const verify = new Database(dbPath(), { readonly: true });
    expect(verify.prepare('SELECT id FROM review_items').get()).toEqual({ id: 'r1' });
    verify.close();
  });

  it('rejects a nonempty WAL legacy snapshot without touching source DB/WAL/SHM files', () => {
    const writer = new Database(dbPath());
    writer.pragma('journal_mode = WAL');
    seedKnownLegacyReviewItems(writer);
    const now = new Date().toISOString();
    writer.prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u@test', ?, ?)`,
    ).run(now, now);
    writer.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'WAL Legacy Review Data', ?, ?)`,
    ).run(now, now);
    writer.prepare(
      `INSERT INTO review_items
         (id, novel_id, source, severity, status, created_at, updated_at)
       VALUES ('r1', 'n1', 'author_todo', 'minor', 'open', ?, ?)`,
    ).run(now, now);
    expect(existsSync(`${dbPath()}-wal`)).toBe(true);
    expect(existsSync(`${dbPath()}-shm`)).toBe(true);
    const before = databaseFileState();

    expect(() => getDb()).toThrow(/review_items table contains data/);
    expect(databaseFileState()).toEqual(before);
    expect(writer.prepare('SELECT id FROM review_items').get()).toEqual({ id: 'r1' });
    writer.close();
  });

  it('retries the inspection snapshot when a WAL checkpoint races the main/WAL copy', () => {
    const writer = new Database(dbPath());
    writer.pragma('journal_mode = WAL');
    seedKnownLegacyReviewItems(writer);
    expect(existsSync(`${dbPath()}-wal`)).toBe(true);
    let checkpointInjected = false;

    expect(() => inspectExistingDatabaseWithoutTouchingSource(dbPath(), () => {
      if (checkpointInjected) return;
      checkpointInjected = true;
      writer.pragma('wal_checkpoint(TRUNCATE)');
    })).not.toThrow();
    expect(checkpointInjected).toBe(true);
    expect(writer.prepare('SELECT COUNT(*) AS count FROM review_items').get()).toEqual({ count: 0 });
    writer.close();
  });

  it('does not block the exact known migration when its optional backup fails', () => {
    const setup = new Database(dbPath());
    seedKnownLegacyReviewItems(setup);
    setup.close();

    const db = new Database(dbPath());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => ensureCurrentSchema(db, () => {
      throw new Error('disk full');
    })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pre-migration backup failed'));
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_items'").get(),
    ).toBeUndefined();
    db.close();
  });

  it('rolls back a failed destructive promotion and preserves the legacy shape', () => {
    const db = new Database(':memory:');
    seedKnownLegacyReviewItems(db);
    db.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'Keep', '', '')`,
    ).run();

    const boom = new Error('forced ddl failure');
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('knowledge_vault_outbox')) throw boom;
      return exec(sql);
    });

    expect(() => ensureCurrentSchema(db, () => null)).toThrow('forced ddl failure');
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'review_items'").get(),
    ).toEqual({ name: 'review_items' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM _schema_version').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT title FROM novels WHERE id = ?').get('n1')).toEqual({ title: 'Keep' });
    db.close();
  });

  it('revalidates under the write lock and preserves a review item inserted after backup', () => {
    const setup = new Database(dbPath());
    seedKnownLegacyReviewItems(setup);
    const now = new Date().toISOString();
    setup.prepare(
      `INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u@test', ?, ?)`,
    ).run(now, now);
    setup.prepare(
      `INSERT INTO novels (id, user_id, title, created_at, updated_at)
       VALUES ('n1', 'u1', 'Concurrent Legacy Data', ?, ?)`,
    ).run(now, now);
    setup.close();

    const primary = new Database(dbPath());
    expect(() => ensureCurrentSchema(primary, () => {
      const concurrent = new Database(dbPath());
      try {
        concurrent.prepare(
          `INSERT INTO review_items
             (id, novel_id, source, severity, status, created_at, updated_at)
           VALUES ('r1', 'n1', 'author_todo', 'minor', 'open', ?, ?)`,
        ).run(now, now);
      } finally {
        concurrent.close();
      }
      return `${dbPath()}.verified-fixture.bak`;
    })).toThrow(/review_items table contains data/);
    expect(primary.prepare('SELECT id FROM review_items').get()).toEqual({ id: 'r1' });
    expect(primary.prepare('SELECT COUNT(*) AS count FROM _schema_version').get()).toEqual({ count: 2 });
    primary.close();
  });

  it('rejects a semantically similar but non-identical legacy SQL oracle', () => {
    const bad = new Database(dbPath());
    bad.exec(PUBLISHED_SCHEMA_18_DDL);
    bad.exec(KNOWN_LEGACY_REVIEW_ITEMS_DDL.replace(
      'source          TEXT NOT NULL',
      'source          TEXT COLLATE NOCASE NOT NULL',
    ));
    bad.exec(`
CREATE TABLE _schema_version (
  version     INTEGER NOT NULL,
  description TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);
`);
    const insert = bad.prepare(
      'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
    );
    for (const marker of KNOWN_LEGACY_REVIEW_ITEMS_MARKERS) {
      insert.run(marker.version, marker.description, '2026-07-01T00:00:00.000Z');
    }
    bad.pragma(`user_version = ${PUBLISHED_SCHEMA_18_VERSION}`);
    expect(computeSchemaFingerprint(bad).digest).toBe(knownLegacyReviewItemsFingerprint().digest);
    bad.close();
    const before = databaseFileState();

    expect(() => getDb()).toThrow(/SQL oracle does not match/);
    expect(databaseFileState()).toEqual(before);
  });

  it('rejects dual markers without the exact review_items fingerprint without mutation', () => {
    const bad = new Database(dbPath());
    seedPublishedSchema18(bad);
    bad.prepare('DELETE FROM _schema_version').run();
    const insert = bad.prepare(
      'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
    );
    for (const marker of KNOWN_LEGACY_REVIEW_ITEMS_MARKERS) {
      insert.run(marker.version, marker.description, '2026-07-01T00:00:00.000Z');
    }
    bad.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(/known legacy review_items structural fingerprint/);
    expect(digest(dbPath())).toBe(before);
  });

  it('rejects forged extra objects on the known legacy shape without mutation', () => {
    const bad = new Database(dbPath());
    seedKnownLegacyReviewItems(bad);
    bad.exec('CREATE TABLE unexpected_extra (id TEXT PRIMARY KEY)');
    bad.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(/known legacy review_items structural fingerprint/);
    expect(digest(dbPath())).toBe(before);
  });

  it('rejects arbitrary multi-row markers without mutation', () => {
    const bad = new Database(dbPath());
    seedPublishedSchema18(bad);
    bad.prepare(
      'INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)',
    ).run(17, 'forged_extra', '2026-07-01T00:00:00.000Z');
    bad.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(/schema marker is missing or ambiguous/);
    expect(digest(dbPath())).toBe(before);
  });
});

describe('fail-closed unknown / future schemas', () => {
  it('leaves an incompatible nonempty database byte-identical until the user chooses to clear it', () => {
    const old = new Database(dbPath());
    old.exec('CREATE TABLE legacy_unsupported_shape (id TEXT PRIMARY KEY); INSERT INTO legacy_unsupported_shape VALUES (\'keep\');');
    old.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(IncompatibleDatabaseSchemaError);
    expect(() => getDb()).toThrow(/clear the local library/i);
    expect(() => getDb()).not.toThrow(/unpublished|local-state:reset/i);
    expect(digest(dbPath())).toBe(before);

    const verify = new Database(dbPath(), { readonly: true });
    expect(verify.prepare('SELECT id FROM legacy_unsupported_shape').get()).toEqual({ id: 'keep' });
    verify.close();
  });

  it('rejects unknown legacy versions without modifying the file', () => {
    const legacy = new Database(dbPath());
    seedPublishedSchema18(legacy);
    legacy.prepare('UPDATE _schema_version SET version = ?').run(12);
    legacy.pragma('user_version = 12');
    legacy.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(IncompatibleDatabaseSchemaError);
    expect(digest(dbPath())).toBe(before);
  });

  it('rejects schema 18 with a forged same-name table / dropped trigger without mutation', () => {
    const bad = new Database(dbPath());
    seedPublishedSchema18(bad);
    bad.exec('DROP TRIGGER trg_knowledge_relation_no_self');
    bad.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(/schema 18 structural fingerprint/);
    expect(digest(dbPath())).toBe(before);
  });

  it('rejects a forged schema marker description without modifying published bytes', () => {
    const bad = new Database(dbPath());
    seedPublishedSchema18(bad);
    bad.prepare("UPDATE _schema_version SET description = 'forged'").run();
    bad.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(/schema 18 structural fingerprint/);
    expect(digest(dbPath())).toBe(before);
  });

  it('rejects schema 18 with a non-published table set', () => {
    const bad = new Database(dbPath());
    seedPublishedSchema18(bad);
    bad.exec('CREATE TABLE unexpected_extra (id TEXT PRIMARY KEY)');
    bad.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(/schema 18 structural fingerprint/);
    expect(digest(dbPath())).toBe(before);
  });

  it('rejects schema 1 that is not the legacy outbox shape', () => {
    const bad = new Database(dbPath());
    seedPublishedSchema18(bad);
    bad.prepare('UPDATE _schema_version SET version = ?').run(1);
    bad.pragma('user_version = 1');
    bad.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(/schema 1 structural fingerprint/);
    expect(digest(dbPath())).toBe(before);
  });

  it('rejects wrong user_version without modifying the file', () => {
    const bad = new Database(dbPath());
    seedPublishedSchema18(bad);
    bad.pragma('user_version = 17');
    bad.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(/user_version/);
    expect(digest(dbPath())).toBe(before);
  });

  it('preserves the typed newer-database failure without modifying the file', () => {
    const newer = new Database(dbPath());
    initializeCurrentSchema(newer);
    newer.prepare('UPDATE _schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION + 1);
    newer.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(DatabaseFromNewerAppVersionError);
    expect(digest(dbPath())).toBe(before);
  });
});

describe('mapLocalDatabaseApiError', () => {
  it('returns stable non-secret codes for typed database failures', async () => {
    const { mapLocalDatabaseApiError } = await import('@/lib/db/migrations');
    expect(mapLocalDatabaseApiError(new DatabaseFromNewerAppVersionError(99, 21))).toMatchObject({
      code: 'DATABASE_NEWER_VERSION',
      status: 503,
    });
    expect(mapLocalDatabaseApiError(new IncompatibleDatabaseSchemaError('fixture'))).toMatchObject({
      code: 'DATABASE_INCOMPATIBLE',
      status: 503,
    });
    expect(mapLocalDatabaseApiError(new LocalDatabaseUnavailableError('internal path detail'))).toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      status: 503,
    });
    expect(mapLocalDatabaseApiError(new Error('InkMarshal: could not open local database at /secret/path'))).toBeNull();
    expect(mapLocalDatabaseApiError(new Error('validation failed'))).toBeNull();
  });
});

describe('createVerifiedBackup', () => {
  it('writes an integrity-checked backup beside an on-disk database', () => {
    const db = new Database(dbPath());
    initializeCurrentSchema(db);
    const backupPath = createVerifiedBackup(db, 19);
    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
    const verify = new Database(backupPath!, { readonly: true });
    expect(verify.pragma('integrity_check', { simple: true })).toBe('ok');
    verify.close();
    db.close();
  });

  it('returns null for in-memory databases', () => {
    const db = new Database(':memory:');
    initializeCurrentSchema(db);
    expect(createVerifiedBackup(db, 19)).toBeNull();
    db.close();
  });

  it('removes an unpublished temporary backup when verification setup fails', () => {
    const db = new Database(dbPath());
    initializeCurrentSchema(db);
    const exec = db.exec.bind(db);
    vi.spyOn(db, 'exec').mockImplementation((sql: string) => {
      const result = exec(sql);
      if (sql.startsWith('VACUUM INTO')) throw new Error('forced post-write failure');
      return result;
    });

    expect(() => createVerifiedBackup(db, 19)).toThrow('forced post-write failure');
    expect(readdirSync(dataDir).filter(name => name.endsWith('.tmp'))).toHaveLength(0);
    expect(readdirSync(dataDir).filter(name => name.endsWith('.bak'))).toHaveLength(0);
    db.close();
  });
});

describe('frozen DDL independence', () => {
  it('loads schema-18/19 from frozen constants rather than stripping current DDL at runtime', () => {
    expect(PUBLISHED_SCHEMA_18_DDL).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(PUBLISHED_SCHEMA_18_DDL).not.toContain('knowledge_vault_outbox');
    expect(PUBLISHED_SCHEMA_19_DDL).toContain('knowledge_vault_outbox');
    expect(PUBLISHED_SCHEMA_19_DDL).not.toContain('processing_status');
    expect(currentSchemaSql).toContain('knowledge_vault_outbox');
    expect(currentSchemaSql).toMatch(/intent_revision\s+INTEGER NOT NULL DEFAULT 1/);
    expect(currentSchemaSql).toContain('processing_status');
    expect(currentSchemaSql).toContain('chat_turns');
    expect(currentSchemaSql).toContain('chat_turn_tool_snapshots');
    expect(SCHEMA_21_CHAT_TURNS_DDL).toContain('chat_turn_tool_snapshots');
    expect(SCHEMA_21_CHAT_TURNS_DDL).toContain('import_confirmations');
    expect(SCHEMA_21_CHAT_TURNS_DDL).toContain('brainstorm_receipts');
    expect(currentSchemaSql).toContain('import_confirmations');
    expect(currentSchemaSql).toContain('brainstorm_receipts');
    expect(SCHEMA_20_DDL).toContain('processing_status');
    expect(SCHEMA_20_DDL).not.toContain('chat_turns');
    expect(SCHEMA_20_DDL).not.toContain('import_confirmations');
    expect(PUBLISHED_SCHEMA_18_DDL).not.toContain('knowledge_vault_outbox');
    expect(PUBLISHED_SCHEMA_18_DDL).not.toContain('intent_revision');
  });
});
