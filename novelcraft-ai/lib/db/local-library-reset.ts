import 'server-only';

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { LOCAL_DB_FILE, resolveLocalDbDir } from '@/lib/db-local-path';
import { closeDb, getDb } from '@/lib/db/connection';
import {
  discardAppOwnedVaultQuarantine,
  quarantineAppOwnedVaultRoot,
  restoreAppOwnedVaultQuarantine,
  type AppOwnedVaultQuarantine,
} from '@/lib/vault/app-owned-cleanup';

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

interface ArtifactQuarantine {
  source: string;
  quarantine: string;
}

/** @internal Test seam: runs after SQLite artifacts are quarantined, before getDb(). */
export const __localLibraryResetTest = {
  afterArtifactsQuarantined: null as null | (() => void),
};

function quarantineLocalLibraryArtifacts(dbDir: string): ArtifactQuarantine[] {
  const token = crypto.randomUUID();
  const quarantines: ArtifactQuarantine[] = [];
  try {
    for (const entry of readdirSync(dbDir, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!isLocalLibraryArtifact(entry.name)) continue;
      const source = path.join(dbDir, entry.name);
      // Same-directory rename keeps the quarantine on the same volume and leaves
      // a reversible handle. The prefix never matches the exact allowlist.
      const quarantine = path.join(dbDir, `.library-reset-${token}-${entry.name}`);
      renameSync(source, quarantine);
      quarantines.push({ source, quarantine });
    }
  } catch (error) {
    // A later rename can fail after earlier artifacts already moved. Roll back
    // here because the caller cannot receive a partially built return value.
    restoreArtifactQuarantines(quarantines);
    throw error;
  }
  return quarantines;
}

function removeNewlyCreatedLibraryArtifacts(
  dbDir: string,
  quarantines: readonly ArtifactQuarantine[],
): void {
  const quarantinePaths = new Set(quarantines.map(item => item.quarantine));
  for (const entry of readdirSync(dbDir, { withFileTypes: true })) {
    if (!isLocalLibraryArtifact(entry.name)) continue;
    const fullPath = path.join(dbDir, entry.name);
    if (quarantinePaths.has(fullPath)) continue;
    rmSync(fullPath, { recursive: true, force: true });
  }
}

function restoreArtifactQuarantines(quarantines: readonly ArtifactQuarantine[]): void {
  for (const item of quarantines) {
    if (!existsSync(item.quarantine)) continue;
    if (existsSync(item.source)) {
      rmSync(item.source, { recursive: true, force: true });
    }
    renameSync(item.quarantine, item.source);
  }
}

function discardArtifactQuarantines(quarantines: readonly ArtifactQuarantine[]): void {
  for (const item of quarantines) {
    rmSync(item.quarantine, { recursive: true, force: true });
  }
}

/**
 * Clears author-created library content while preserving product setup stored
 * in app_settings (providers, model bindings, preferences, and model root) and
 * developer prompt customizations. This is the normal Settings action; it
 * requires a healthy database and never falls back to deleting the DB file.
 */
export function clearLocalLibraryContent(): void {
  const db = getDb();
  const vaultQuarantine = quarantineAppOwnedVaultRoot();
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
    restoreAppOwnedVaultQuarantine(vaultQuarantine);
    throw error;
  }
  discardAppOwnedVaultQuarantine(vaultQuarantine);
}

/**
 * Permanently clears the local writing library after explicit UI confirmation.
 * App-owned model files, provider files, logs, and external Vault directories
 * are outside this exact-name allowlist and remain untouched.
 *
 * Failure restores every previous SQLite artifact and the app-owned Vault.
 * Success creates a verified current-schema library before discarding quarantine.
 */
export function resetLocalLibrary(): void {
  const dbDir = resolveLocalDbDir();
  closeDb();
  mkdirSync(dbDir, { recursive: true });

  let vaultQuarantine: AppOwnedVaultQuarantine | null = null;
  let artifactQuarantines: ArtifactQuarantine[] = [];
  try {
    vaultQuarantine = quarantineAppOwnedVaultRoot();
    artifactQuarantines = quarantineLocalLibraryArtifacts(dbDir);
    __localLibraryResetTest.afterArtifactsQuarantined?.();

    // Return success only after a clean current-schema library can be opened.
    getDb();
  } catch (error) {
    closeDb();
    removeNewlyCreatedLibraryArtifacts(dbDir, artifactQuarantines);
    restoreArtifactQuarantines(artifactQuarantines);
    restoreAppOwnedVaultQuarantine(vaultQuarantine);
    throw error;
  }

  discardArtifactQuarantines(artifactQuarantines);
  discardAppOwnedVaultQuarantine(vaultQuarantine);
}
