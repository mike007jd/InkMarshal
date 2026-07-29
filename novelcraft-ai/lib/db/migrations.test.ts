import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDbForTest, getDb } from '@/lib/db/connection';
import {
  assertCurrentSchema,
  createVerifiedBackup,
  DatabaseFromNewerAppVersionError,
  IncompatibleDatabaseSchemaError,
  ensureCurrentSchema,
  initializeCurrentSchema,
  legacySchema1Fingerprint,
  publishedSchema18Fingerprint,
  currentSchema19Fingerprint,
} from '@/lib/db/migrations';
import {
  computeSchemaFingerprint,
  computeSqliteSchemaSqlOracle,
} from '@/lib/db/schema-fingerprint';
import {
  CURRENT_SCHEMA_TABLES,
  CURRENT_SCHEMA_VERSION,
  LEGACY_SCHEMA_1_DDL,
  LEGACY_SCHEMA_1_SQL_ORACLE,
  LEGACY_SCHEMA_1_SQL_ORACLE_OBJECT_COUNT,
  PUBLISHED_SCHEMA_18_DDL,
  PUBLISHED_SCHEMA_18_SQL_ORACLE,
  PUBLISHED_SCHEMA_18_SQL_ORACLE_OBJECT_COUNT,
  PUBLISHED_SCHEMA_18_TABLES,
  PUBLISHED_SCHEMA_18_VERSION,
  SCHEMA_19_OUTBOX_DDL,
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

    const current = new Database(':memory:');
    initializeCurrentSchema(current);
    expect(computeSchemaFingerprint(current).digest).toBe(currentSchema19Fingerprint().digest);
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

describe('current schema epoch 19', () => {
  it('initializes a fresh database at schema 19 with the current table set', () => {
    const db = getDb();
    expect(CURRENT_SCHEMA_VERSION).toBe(19);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(tables(db)).toEqual([...CURRENT_SCHEMA_TABLES]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM _schema_version').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM prompt_templates').get() as { count: number }).count)
      .toBeGreaterThan(0);
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_vault_outbox'").get(),
    ).toMatchObject({ sql: expect.stringContaining("status") });
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

describe('published schema 18 → 19', () => {
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
    expect(db.pragma('user_version', { simple: true })).toBe(19);
    expect(tables(db)).toEqual([...CURRENT_SCHEMA_TABLES]);
    expect(db.prepare('SELECT title FROM novels WHERE id = ?').get('n1')).toEqual({ title: 'Shipped Book' });
    expect(db.prepare('SELECT title FROM chapters WHERE id = ?').get('c1')).toEqual({ title: 'One' });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_vault_outbox'").get(),
    ).toEqual({ name: 'knowledge_vault_outbox' });
    expect(
      db.prepare('PRAGMA table_info(knowledge_vault_outbox)').all() as Array<{ name: string }>,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'status' }),
      expect.objectContaining({ name: 'intent_revision' }),
    ]));

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

  it('warns and proceeds when pre-migration backup fails for additive 18→19', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const db = new Database(':memory:');
    seedPublishedSchema18(db);
    ensureCurrentSchema(db, () => {
      throw new Error('disk full');
    });
    expect(tables(db)).toEqual([...CURRENT_SCHEMA_TABLES]);
    expect(db.prepare('SELECT version FROM _schema_version').get()).toEqual({ version: 19 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pre-migration backup failed'));
    db.close();
    warn.mockRestore();
  });
});

describe('mis-stamped schema 1 legacy-outbox → 19', () => {
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
    expect(db.pragma('user_version', { simple: true })).toBe(19);
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

describe('fail-closed unknown / future schemas', () => {
  it('leaves an incompatible nonempty database byte-identical and avoids destructive reset guidance', () => {
    const old = new Database(dbPath());
    old.exec('CREATE TABLE legacy_unsupported_shape (id TEXT PRIMARY KEY); INSERT INTO legacy_unsupported_shape VALUES (\'keep\');');
    old.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(IncompatibleDatabaseSchemaError);
    expect(() => getDb()).toThrow(/Preserve a backup|contact support|update InkMarshal/i);
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
});

describe('frozen DDL independence', () => {
  it('loads schema-18 from the frozen tagged constant rather than stripping current DDL at runtime', () => {
    expect(PUBLISHED_SCHEMA_18_DDL).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(PUBLISHED_SCHEMA_18_DDL).not.toContain('knowledge_vault_outbox');
    // Current epoch carries outbox status + intent_revision; frozen 18 must not.
    expect(currentSchemaSql).toContain('knowledge_vault_outbox');
    expect(currentSchemaSql).toMatch(/intent_revision\s+INTEGER NOT NULL DEFAULT 1/);
    expect(PUBLISHED_SCHEMA_18_DDL).not.toContain('knowledge_vault_outbox');
    expect(PUBLISHED_SCHEMA_18_DDL).not.toContain('intent_revision');
  });
});
