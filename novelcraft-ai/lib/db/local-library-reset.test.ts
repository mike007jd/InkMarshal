import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDbForTest, getDb } from '@/lib/db/connection';
import {
  __localLibraryResetTest,
  clearLocalLibraryContent,
  resetLocalLibrary,
} from '@/lib/db/local-library-reset';
import { CURRENT_SCHEMA_VERSION } from '@/lib/db/schema';

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let dataDir: string;

function dbPath(): string {
  return path.join(dataDir, 'inkmarshal.db');
}

beforeEach(() => {
  closeDbForTest();
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-library-reset-'));
  process.env.INKMARSHAL_DATA_DIR = dataDir;
});

afterEach(() => {
  __localLibraryResetTest.afterArtifactsQuarantined = null;
  closeDbForTest();
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('local library reset', () => {
  it('clears writing data without deleting app settings or prompt customizations', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const appVaultPath = path.join(dataDir, 'vaults', 'novel-1', 'characters', 'hero.md');
    const externalVaultPath = path.join(path.dirname(dataDir), `${path.basename(dataDir)}-external-vault`, 'hero.md');
    mkdirSync(path.dirname(appVaultPath), { recursive: true });
    mkdirSync(path.dirname(externalVaultPath), { recursive: true });
    writeFileSync(appVaultPath, 'app-owned');
    writeFileSync(externalVaultPath, 'external');
    db.prepare('INSERT INTO series (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('series-1', 'Series', now, now);
    db.prepare('INSERT INTO novels (id, user_id, series_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('novel-1', 'local-user', 'series-1', now, now);
    db.prepare('INSERT INTO import_confirmations (session_token, request_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('import-1', 'hash', 'pending', now, now);
    db.prepare('INSERT INTO ai_runs (id, novel_id, operation, created_at) VALUES (?, ?, ?, ?)')
      .run('run-1', 'novel-1', 'chat', now);
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('inkmarshal_settings', '{"theme":"dark"}', now);
    db.prepare('INSERT INTO prompt_templates (id, stage, template_text, created_at) VALUES (?, ?, ?, ?)')
      .run('custom-prompt', 'brainstorm', 'Keep me', now);

    clearLocalLibraryContent();

    expect(db.prepare('SELECT COUNT(*) AS count FROM novels').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM series').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM import_confirmations').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM ai_runs').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('inkmarshal_settings'))
      .toEqual({ value: '{"theme":"dark"}' });
    expect(db.prepare('SELECT template_text FROM prompt_templates WHERE id = ?').get('custom-prompt'))
      .toEqual({ template_text: 'Keep me' });
    expect(existsSync(appVaultPath)).toBe(false);
    expect(readFileSync(externalVaultPath, 'utf8')).toBe('external');
    rmSync(path.dirname(externalVaultPath), { recursive: true, force: true });
  });

  it('restores the app-owned Vault when the database clear transaction fails', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const appVaultPath = path.join(dataDir, 'vaults', 'novel-1', 'characters', 'hero.md');
    mkdirSync(path.dirname(appVaultPath), { recursive: true });
    writeFileSync(appVaultPath, 'keep-after-failure');
    db.prepare('INSERT INTO novels (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('novel-1', 'local-user', now, now);
    db.exec(`
      CREATE TRIGGER fail_library_clear
      BEFORE DELETE ON novels
      BEGIN
        SELECT RAISE(ABORT, 'forced clear failure');
      END;
    `);

    expect(() => clearLocalLibraryContent()).toThrow(/forced clear failure/);

    expect(db.prepare('SELECT id FROM novels WHERE id = ?').get('novel-1')).toEqual({ id: 'novel-1' });
    expect(readFileSync(appVaultPath, 'utf8')).toBe('keep-after-failure');
  });

  it('replaces an incompatible database with a usable empty library', () => {
    const incompatible = new Database(dbPath());
    incompatible.exec('CREATE TABLE abandoned_dev_shape (value TEXT)');
    incompatible.close();

    const obsoleteArtifacts = [
      `${dbPath()}-wal`,
      `${dbPath()}-shm`,
      `${dbPath()}-journal`,
      `${dbPath()}.pre-migration-v20-2026-08-01T00-00-00-000Z.bak`,
      `${dbPath()}.pre-migration-v20-2026-08-01T00-00-00-000Z.bak.tmp`,
    ];
    for (const filePath of obsoleteArtifacts) writeFileSync(filePath, 'obsolete');

    expect(() => getDb()).toThrow(/incompatible/i);

    resetLocalLibrary();

    const fresh = getDb();
    expect(fresh.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(
      fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'abandoned_dev_shape'").get(),
    ).toBeUndefined();
    expect(fresh.prepare('SELECT COUNT(*) AS count FROM novels').get()).toEqual({ count: 0 });
    expect(existsSync(`${dbPath()}-journal`)).toBe(false);
    expect(existsSync(obsoleteArtifacts[3])).toBe(false);
    expect(existsSync(obsoleteArtifacts[4])).toBe(false);
  });

  it('removes only SQLite library artifacts and preserves models and app files', () => {
    const live = getDb();
    live.exec('CREATE TABLE reset_sentinel (value TEXT)');

    const migrationBackups = [
      `${dbPath()}.pre-migration-v20-2026-08-01T00-00-00-000Z.bak`,
      `${dbPath()}.pre-migration-v20-2026-08-01T00-00-00-000Z.bak.tmp`,
    ];
    for (const filePath of migrationBackups) writeFileSync(filePath, 'obsolete');

    const modelPath = path.join(dataDir, 'models', 'keep.gguf');
    const settingsPath = path.join(dataDir, 'provider-connections.json');
    const logPath = path.join(dataDir, 'logs', 'app.log');
    const appVaultPath = path.join(dataDir, 'vaults', 'old-novel', 'worlds', 'city.md');
    mkdirSync(path.dirname(modelPath), { recursive: true });
    mkdirSync(path.dirname(logPath), { recursive: true });
    mkdirSync(path.dirname(appVaultPath), { recursive: true });
    writeFileSync(modelPath, 'model-bytes');
    writeFileSync(settingsPath, '{"keep":true}');
    writeFileSync(logPath, 'keep-logs');
    writeFileSync(appVaultPath, 'obsolete-vault');

    resetLocalLibrary();

    expect(migrationBackups.every(filePath => !existsSync(filePath))).toBe(true);
    expect(readFileSync(modelPath, 'utf8')).toBe('model-bytes');
    expect(readFileSync(settingsPath, 'utf8')).toBe('{"keep":true}');
    expect(readFileSync(logPath, 'utf8')).toBe('keep-logs');
    expect(existsSync(appVaultPath)).toBe(false);
    expect(
      getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'reset_sentinel'").get(),
    ).toBeUndefined();
  });

  it('restores every SQLite artifact and the app-owned Vault when new library validation fails', () => {
    const live = getDb();
    const now = new Date().toISOString();
    live.prepare('INSERT INTO novels (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('novel-keep', 'local-user', now, now);
    live.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('inkmarshal_settings', '{"theme":"restore-me"}', now);
    const walPath = `${dbPath()}-wal`;
    const shmPath = `${dbPath()}-shm`;
    const journalPath = `${dbPath()}-journal`;
    const backupPath = `${dbPath()}.pre-migration-v20-2026-08-01T00-00-00-000Z.bak`;
    const appVaultPath = path.join(dataDir, 'vaults', 'novel-keep', 'characters', 'hero.md');
    mkdirSync(path.dirname(appVaultPath), { recursive: true });
    writeFileSync(appVaultPath, 'vault-keep');
    const modelPath = path.join(dataDir, 'models', 'keep.gguf');
    mkdirSync(path.dirname(modelPath), { recursive: true });
    writeFileSync(modelPath, 'model-bytes');

    // Snapshot after close so the main DB includes checkpointed writes, then
    // plant exact allowlisted sidecars that must round-trip through failure.
    closeDbForTest();
    const originalDb = readFileSync(dbPath());
    writeFileSync(walPath, 'wal-bytes');
    writeFileSync(shmPath, 'shm-bytes');
    writeFileSync(journalPath, 'journal-bytes');
    writeFileSync(backupPath, 'backup-bytes');
    __localLibraryResetTest.afterArtifactsQuarantined = () => {
      // Occupy the live DB path so the replacement library cannot be created.
      mkdirSync(dbPath());
    };

    expect(() => resetLocalLibrary()).toThrow();

    expect(readFileSync(dbPath())).toEqual(originalDb);
    expect(readFileSync(walPath, 'utf8')).toBe('wal-bytes');
    expect(readFileSync(shmPath, 'utf8')).toBe('shm-bytes');
    expect(readFileSync(journalPath, 'utf8')).toBe('journal-bytes');
    expect(readFileSync(backupPath, 'utf8')).toBe('backup-bytes');
    expect(readFileSync(appVaultPath, 'utf8')).toBe('vault-keep');
    expect(readFileSync(modelPath, 'utf8')).toBe('model-bytes');
    expect(readdirSync(dataDir).some(name => name.startsWith('.library-reset-'))).toBe(false);
    expect(readdirSync(dataDir).some(name => name.startsWith('.vaults-clear-'))).toBe(false);

    // Drop the intentionally invalid sidecars before verifying SQL content.
    rmSync(walPath, { force: true });
    rmSync(shmPath, { force: true });
    rmSync(journalPath, { force: true });
    const restored = getDb();
    expect(restored.prepare('SELECT id FROM novels WHERE id = ?').get('novel-keep'))
      .toEqual({ id: 'novel-keep' });
    expect(restored.prepare('SELECT value FROM app_settings WHERE key = ?').get('inkmarshal_settings'))
      .toEqual({ value: '{"theme":"restore-me"}' });
  });
});
