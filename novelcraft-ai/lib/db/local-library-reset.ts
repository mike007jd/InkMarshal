import 'server-only';

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { resolveLocalDbDir } from '@/lib/db-local-path';
import { closeDb, getDb } from '@/lib/db/connection';
import {
  createLibraryResetIntent,
  isLocalLibraryArtifact,
  markLibraryResetIntentCommitted,
  removeLibraryResetIntent,
  type LibraryArtifactQuarantine,
} from '@/lib/db/local-library-reset-intent';
import {
  discardAppOwnedVaultQuarantine,
  quarantineAppOwnedVaultRoot,
  restoreAppOwnedVaultQuarantine,
  type AppOwnedVaultQuarantine,
} from '@/lib/vault/app-owned-cleanup';

/** @internal Test seam: runs after SQLite artifacts are quarantined, before getDb(). */
export const __localLibraryResetTest = {
  afterArtifactQuarantined: null as null | ((count: number) => void),
  afterArtifactsQuarantined: null as null | (() => void),
};

function quarantineLocalLibraryArtifacts(dbDir: string): {
  artifacts: LibraryArtifactQuarantine[];
  intentPath: string;
} {
  const token = crypto.randomUUID();
  const artifacts = readdirSync(dbDir, { withFileTypes: true })
    .filter(entry => (entry.isFile() || entry.isSymbolicLink()) && isLocalLibraryArtifact(entry.name))
    .map(entry => ({
      source: path.join(dbDir, entry.name),
      quarantine: path.join(dbDir, `.library-reset-${token}-${entry.name}`),
      sourceName: entry.name,
      quarantineName: `.library-reset-${token}-${entry.name}`,
    }));
  const intentPath = createLibraryResetIntent(dbDir, artifacts);
  const moved: LibraryArtifactQuarantine[] = [];
  try {
    for (const artifact of artifacts) {
      // Same-directory rename keeps the quarantine on the same volume and leaves
      // a reversible handle. The prefix never matches the exact allowlist.
      renameSync(artifact.source, artifact.quarantine);
      moved.push(artifact);
      __localLibraryResetTest.afterArtifactQuarantined?.(moved.length);
    }
  } catch (error) {
    // A later rename can fail after earlier artifacts already moved. Roll back
    // here because the caller cannot receive a partially built return value.
    restoreArtifactQuarantines(moved);
    removeLibraryResetIntent(intentPath);
    throw error;
  }
  return { artifacts, intentPath };
}

function removeNewlyCreatedLibraryArtifacts(
  dbDir: string,
  quarantines: readonly LibraryArtifactQuarantine[],
): void {
  const quarantinePaths = new Set(quarantines.map(item => item.quarantine));
  for (const entry of readdirSync(dbDir, { withFileTypes: true })) {
    if (!isLocalLibraryArtifact(entry.name)) continue;
    const fullPath = path.join(dbDir, entry.name);
    if (quarantinePaths.has(fullPath)) continue;
    rmSync(fullPath, { recursive: true, force: true });
  }
}

function restoreArtifactQuarantines(quarantines: readonly LibraryArtifactQuarantine[]): void {
  for (const item of quarantines) {
    if (!existsSync(item.quarantine)) continue;
    if (existsSync(item.source)) {
      rmSync(item.source, { recursive: true, force: true });
    }
    renameSync(item.quarantine, item.source);
  }
}

function discardArtifactQuarantines(quarantines: readonly LibraryArtifactQuarantine[]): void {
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
  let artifactQuarantines: LibraryArtifactQuarantine[] = [];
  let resetIntentPath: string | null = null;
  let libraryArtifactsQuarantined = false;
  try {
    vaultQuarantine = quarantineAppOwnedVaultRoot();
    const artifactQuarantine = quarantineLocalLibraryArtifacts(dbDir);
    artifactQuarantines = artifactQuarantine.artifacts;
    resetIntentPath = artifactQuarantine.intentPath;
    libraryArtifactsQuarantined = true;
    __localLibraryResetTest.afterArtifactsQuarantined?.();

    // Return success only after a clean current-schema library can be opened.
    getDb();
    markLibraryResetIntentCommitted(resetIntentPath);
  } catch (error) {
    closeDb();
    // quarantineLocalLibraryArtifacts rolls back its own partial work. Only a
    // completed quarantine can have been followed by creation of a new DB.
    if (libraryArtifactsQuarantined) {
      removeNewlyCreatedLibraryArtifacts(dbDir, artifactQuarantines);
      restoreArtifactQuarantines(artifactQuarantines);
    }
    removeLibraryResetIntent(resetIntentPath);
    restoreAppOwnedVaultQuarantine(vaultQuarantine);
    throw error;
  }

  discardArtifactQuarantines(artifactQuarantines);
  removeLibraryResetIntent(resetIntentPath);
  discardAppOwnedVaultQuarantine(vaultQuarantine);
}
