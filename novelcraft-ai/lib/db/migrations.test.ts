import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  runMigrations,
  inspectMigrations,
  createVerifiedBackup,
  DatabaseFromNewerAppVersionError,
} from '@/lib/db/migrations';
import { migrations, BASELINE_SCHEMA_VERSION, NEXT_SCHEMA_VERSION, type Migration } from '@/lib/db/schema';

const EXPECTED_TABLES = [
  '_schema_version',
  'activity_events',
  'ai_runs',
  'app_settings',
  'chapter_chat_history',
  'chapters',
  'conversations',
  'knowledge_embeddings',
  'knowledge_entries',
  'knowledge_index',
  'knowledge_relations',
  'messages',
  'novels',
  'prompt_templates',
  'series',
  'users',
  'writing_jobs',
];

function tables(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(row => (row as { name: string }).name)
    .filter(name => !name.startsWith('sqlite_'));
}

/** Simulate a released database already at the given schema version (v0.1.0
 *  shipped at 18): apply the current baseline shape, then stamp the version. */
function seedReleasedDb(db: Database.Database, version: number): void {
  db.exec(migrations[0].sql);
  db.exec(
    'CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL, description TEXT NOT NULL, applied_at TEXT NOT NULL);',
  );
  db.prepare('INSERT INTO _schema_version (version, description, applied_at) VALUES (?, ?, ?)')
    .run(version, 'shipped', '2026-07-01T00:00:00.000Z');
}

describe('schema baseline — logical epoch 18', () => {
  it('creates the current local-first shape in one baseline stamped at the epoch', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);

      expect(migrations).toHaveLength(1);
      expect(BASELINE_SCHEMA_VERSION).toBe(18);
      expect(NEXT_SCHEMA_VERSION).toBe(19);
      expect(inspectMigrations(db)).toEqual({ current: 18, pending: 0, pendingDestructive: false });
      expect(db.pragma('user_version', { simple: true })).toBe(18);

      expect(tables(db)).toEqual(EXPECTED_TABLES);

      const novelColumns = db
        .prepare('PRAGMA table_info(novels)')
        .all()
        .map(row => (row as { name: string }).name);
      expect(novelColumns).toContain('series_id');
      expect(novelColumns).toContain('vault_path');
      expect(novelColumns).not.toContain('blueprint');

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO users (id, email, created_at, updated_at)
         VALUES ('local-user', 'local@example.test', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO novels (id, user_id, title, created_at, updated_at)
         VALUES ('novel', 'local-user', 'Novel', ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO knowledge_entries
          (id, novel_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
         VALUES ('entry', 'novel', 'character', 'Entry', '', '{}', 0, '[]', ?, ?)`,
      ).run(now, now);
      expect(() => {
        db.prepare(
          `INSERT INTO knowledge_relations
            (id, source_id, target_id, relation_type, created_at)
           VALUES ('r', 'entry', 'entry', 'related', ?)`,
        ).run(now);
      }).toThrow('source and target must differ');
      expect(() => {
        db.prepare(
          `INSERT INTO knowledge_relations
            (id, source_id, target_id, relation_type, created_at)
           VALUES ('r2', 'entry', 'missing', 'related', ?)`,
        ).run(now);
      }).toThrow('source and target must belong to the same novel or series');
    } finally {
      db.close();
    }
  });
});

describe('runMigrations — released v18 fixture', () => {
  it('is a no-op on a released-v18 database and preserves its data', () => {
    const db = new Database(':memory:');
    try {
      seedReleasedDb(db, 18);
      db.prepare(
        `INSERT INTO novels (id, user_id, title, genre, stage, progress, created_at, updated_at)
         VALUES ('n1', 'u1', 'Shipped Book', 'f', 'autonomous_writing', 40, '', '')`,
      ).run();

      const before = inspectMigrations(db);
      runMigrations(db);
      const after = inspectMigrations(db);

      expect(before).toEqual({ current: 18, pending: 0, pendingDestructive: false });
      expect(after.current).toBe(18);
      expect(db.prepare('SELECT COUNT(*) c FROM _schema_version').get()).toEqual({ c: 1 });
      expect(db.prepare('SELECT title FROM novels WHERE id = ?').get('n1')).toEqual({ title: 'Shipped Book' });
    } finally {
      db.close();
    }
  });
});

describe('runMigrations — fresh + released converge on the next migration', () => {
  const withNext: Migration[] = [
    ...migrations,
    { version: 19, description: 'add_t19', sql: 'CREATE TABLE IF NOT EXISTS t19 (id TEXT PRIMARY KEY);' },
  ];

  it('upgrades a fresh install to schema 19', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, withNext);
      expect(inspectMigrations(db, withNext)).toEqual({ current: 19, pending: 0, pendingDestructive: false });
      expect(tables(db)).toContain('t19');
    } finally {
      db.close();
    }
  });

  it('upgrades a released-v18 database to the SAME schema 19', () => {
    const db = new Database(':memory:');
    try {
      seedReleasedDb(db, 18);
      runMigrations(db, withNext);
      expect(inspectMigrations(db, withNext).current).toBe(19);
      expect(tables(db)).toContain('t19');
    } finally {
      db.close();
    }
  });
});

describe('runMigrations — newer-than-app database (fail closed)', () => {
  it('refuses to open a database whose schema is newer than this build supports', () => {
    const db = new Database(':memory:');
    try {
      seedReleasedDb(db, 19); // app only knows up to 18
      expect(() => runMigrations(db)).toThrow(DatabaseFromNewerAppVersionError);
      expect(inspectMigrations(db).current).toBe(19);
      expect(db.prepare('SELECT COUNT(*) c FROM _schema_version').get()).toEqual({ c: 1 });
    } finally {
      db.close();
    }
  });
});

describe('runMigrations — destructive migration backup gate', () => {
  const destructive: Migration[] = [
    ...migrations,
    { version: 19, description: 'drop_something', sql: 'CREATE TABLE IF NOT EXISTS t19 (id TEXT PRIMARY KEY);', destructive: true },
  ];

  it('refuses a destructive migration when the backup cannot be verified', () => {
    const db = new Database(':memory:');
    try {
      seedReleasedDb(db, 18);
      const failingBackup = () => {
        throw new Error('disk full');
      };
      expect(() => runMigrations(db, destructive, failingBackup)).toThrow(/without a verified backup/);
      expect(tables(db)).not.toContain('t19');
      expect(inspectMigrations(db, destructive).current).toBe(18);
    } finally {
      db.close();
    }
  });

  it('runs a destructive migration when the backup verifies', () => {
    const db = new Database(':memory:');
    try {
      seedReleasedDb(db, 18);
      const okBackup = () => '/tmp/fake-verified.bak';
      runMigrations(db, destructive, okBackup);
      expect(tables(db)).toContain('t19');
      expect(inspectMigrations(db, destructive).current).toBe(19);
    } finally {
      db.close();
    }
  });

  it('proceeds past a failed backup when no pending step is destructive', () => {
    const additive: Migration[] = [
      ...migrations,
      { version: 19, description: 'add_t19', sql: 'CREATE TABLE IF NOT EXISTS t19 (id TEXT PRIMARY KEY);' },
    ];
    const db = new Database(':memory:');
    try {
      seedReleasedDb(db, 18);
      const failingBackup = () => {
        throw new Error('disk full');
      };
      runMigrations(db, additive, failingBackup);
      expect(tables(db)).toContain('t19');
      expect(inspectMigrations(db, additive).current).toBe(19);
    } finally {
      db.close();
    }
  });
});

describe('runMigrations — rollback on a failing migration', () => {
  it('rolls back the batch and leaves the version untouched when a step throws', () => {
    const broken: Migration[] = [
      ...migrations,
      { version: 19, description: 'broken', sql: 'CREATE TABLE ok19 (id TEXT); THIS IS NOT SQL;' },
    ];
    const db = new Database(':memory:');
    try {
      seedReleasedDb(db, 18);
      expect(() => runMigrations(db, broken)).toThrow(/Schema migration 19/);
      expect(tables(db)).not.toContain('ok19');
      expect(inspectMigrations(db, broken).current).toBe(18);
    } finally {
      db.close();
    }
  });
});

describe('createVerifiedBackup', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-backup-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for an in-memory database (nothing to snapshot)', () => {
    const db = new Database(':memory:');
    try {
      expect(createVerifiedBackup(db, 18)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('writes an integrity-clean snapshot of a file-backed database', () => {
    const dbPath = path.join(dir, 'app.db');
    const db = new Database(dbPath);
    try {
      seedReleasedDb(db, 18);
      const backupPath = createVerifiedBackup(db, 18);
      expect(backupPath).toBeTruthy();
      expect(existsSync(backupPath as string)).toBe(true);
      const snap = new Database(backupPath as string, { readonly: true });
      expect(snap.pragma('integrity_check', { simple: true })).toBe('ok');
      snap.close();
    } finally {
      db.close();
    }
  });
});
