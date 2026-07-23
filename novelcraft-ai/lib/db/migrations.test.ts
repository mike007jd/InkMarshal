import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDbForTest, getDb } from '@/lib/db/connection';
import {
  assertCurrentSchema,
  DatabaseFromNewerAppVersionError,
  IncompatibleDatabaseSchemaError,
  initializeCurrentSchema,
} from '@/lib/db/migrations';
import { CURRENT_SCHEMA_TABLES, CURRENT_SCHEMA_VERSION } from '@/lib/db/schema';

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

beforeEach(() => {
  closeDbForTest();
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-schema-baseline-'));
  process.env.INKMARSHAL_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDbForTest();
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('current prelaunch schema baseline', () => {
  it('initializes a disposable empty root exactly once with current seed data', () => {
    const db = getDb();
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(tables(db)).toEqual([...CURRENT_SCHEMA_TABLES]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM _schema_version').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
    expect((db.prepare('SELECT COUNT(*) AS count FROM prompt_templates').get() as { count: number }).count)
      .toBeGreaterThan(0);
  });

  it('opens a current-schema database without DDL or implicit seed writes', () => {
    const setup = new Database(dbPath());
    initializeCurrentSchema(setup);
    setup.close();

    const db = getDb();
    expect(() => assertCurrentSchema(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM _schema_version').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM prompt_templates').get()).toEqual({ count: 0 });
  });

  it('leaves an incompatible nonempty database byte-identical and fails closed with reset guidance', () => {
    const old = new Database(dbPath());
    old.exec('CREATE TABLE unpublished_old_shape (id TEXT PRIMARY KEY); INSERT INTO unpublished_old_shape VALUES (\'keep\');');
    old.close();
    const before = digest(dbPath());

    expect(() => getDb()).toThrow(IncompatibleDatabaseSchemaError);
    expect(() => getDb()).toThrow(/local-state:reset/);
    expect(digest(dbPath())).toBe(before);

    const verify = new Database(dbPath(), { readonly: true });
    expect(verify.prepare('SELECT id FROM unpublished_old_shape').get()).toEqual({ id: 'keep' });
    verify.close();
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

  it('rolls back a failed first-run bootstrap instead of leaving a partial schema', () => {
    const db = new Database(':memory:');
    expect(() => initializeCurrentSchema(db, () => {
      throw new Error('seed failed');
    })).toThrow('seed failed');
    expect(tables(db)).toEqual([]);
    db.close();
  });
});
