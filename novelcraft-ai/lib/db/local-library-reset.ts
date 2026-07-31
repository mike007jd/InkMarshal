import 'server-only';

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { LOCAL_DB_FILE, resolveLocalDbDir } from '@/lib/db-local-path';
import { closeDb, getDb } from '@/lib/db/connection';

function isLocalLibraryArtifact(fileName: string): boolean {
  if (
    fileName === LOCAL_DB_FILE
    || fileName === `${LOCAL_DB_FILE}-wal`
    || fileName === `${LOCAL_DB_FILE}-shm`
    || fileName === `${LOCAL_DB_FILE}-journal`
  ) return true;

  return fileName.startsWith(`${LOCAL_DB_FILE}.pre-migration-v`)
    && (fileName.endsWith('.bak') || fileName.endsWith('.bak.tmp'));
}

interface VaultQuarantine {
  source: string;
  quarantine: string;
}

function quarantineAppOwnedVaults(dbDir: string): VaultQuarantine | null {
  // The default Vault root is an app-owned child of the canonical app data
  // directory. Custom/external Vault paths are never derived or traversed.
  const source = path.join(dbDir, 'vaults');
  if (!existsSync(source)) return null;
  const quarantine = path.join(dbDir, `.vaults-clear-${crypto.randomUUID()}`);
  renameSync(source, quarantine);
  return { source, quarantine };
}

function restoreVaultQuarantine(value: VaultQuarantine | null): void {
  if (!value || !existsSync(value.quarantine)) return;
  if (existsSync(value.source)) {
    throw new Error('Could not restore the app-owned Vault because its original path was recreated.');
  }
  renameSync(value.quarantine, value.source);
}

function discardVaultQuarantine(value: VaultQuarantine | null): void {
  if (!value) return;
  rmSync(value.quarantine, { recursive: true, force: true });
}

/**
 * Clears author-created library content while preserving product setup stored
 * in app_settings (providers, model bindings, preferences, and model root) and
 * developer prompt customizations. This is the normal Settings action; it
 * requires a healthy database and never falls back to deleting the DB file.
 */
export function clearLocalLibraryContent(): void {
  const db = getDb();
  const dbDir = resolveLocalDbDir();
  const vaultQuarantine = quarantineAppOwnedVaults(dbDir);
  const clear = db.transaction(() => {
    // These two tables are not fully owned by a novel FK and would otherwise
    // leave user activity behind after every novel is removed.
    db.prepare('DELETE FROM import_confirmations').run();
    db.prepare('DELETE FROM ai_runs').run();
    // Novel-owned rows cascade through chapters, chat, Story Deck, Vault
    // outbox, writing jobs, and activity events.
    db.prepare('DELETE FROM novels').run();
    db.prepare('DELETE FROM series').run();
  });
  try {
    clear();
  } catch (error) {
    restoreVaultQuarantine(vaultQuarantine);
    throw error;
  }
  discardVaultQuarantine(vaultQuarantine);
}

/**
 * Permanently clears the local writing library after explicit UI confirmation.
 * App-owned model files, provider files, logs, and external Vault directories
 * are outside this exact-name allowlist and remain untouched.
 */
export function resetLocalLibrary(): void {
  const dbDir = resolveLocalDbDir();
  closeDb();
  mkdirSync(dbDir, { recursive: true });
  const vaultQuarantine = quarantineAppOwnedVaults(dbDir);

  for (const entry of readdirSync(dbDir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!isLocalLibraryArtifact(entry.name)) continue;
    rmSync(path.join(dbDir, entry.name), { force: true });
  }

  // Return success only after a clean current-schema library can be opened.
  try {
    getDb();
  } catch (error) {
    restoreVaultQuarantine(vaultQuarantine);
    throw error;
  }
  discardVaultQuarantine(vaultQuarantine);
}
