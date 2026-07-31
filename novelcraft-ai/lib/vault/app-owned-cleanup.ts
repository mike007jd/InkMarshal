import 'server-only';

import { existsSync, lstatSync, realpathSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { resolveLocalDbDir } from '@/lib/db-local-path';

export interface AppOwnedVaultQuarantine {
  source: string;
  quarantine: string;
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * Moves one app-managed per-novel Vault aside before its database row is
 * deleted. External roots and symlink escapes are deliberately ignored.
 */
export function quarantineAppOwnedNovelVault(
  vaultPath: string | null | undefined,
): AppOwnedVaultQuarantine | null {
  if (!vaultPath) return null;
  const ownedRoot = path.join(resolveLocalDbDir(), 'vaults');
  const requestedPath = path.resolve(vaultPath);
  if (!isStrictDescendant(ownedRoot, requestedPath)) return null;
  if (!existsSync(ownedRoot) || !existsSync(requestedPath)) return null;

  const rootStat = lstatSync(ownedRoot);
  const targetStat = lstatSync(requestedPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return null;

  const realRoot = realpathSync(ownedRoot);
  const realTarget = realpathSync(requestedPath);
  if (!isStrictDescendant(realRoot, realTarget)) return null;

  const quarantine = path.join(ownedRoot, `.delete-${crypto.randomUUID()}`);
  renameSync(requestedPath, quarantine);
  return { source: requestedPath, quarantine };
}

export function restoreAppOwnedNovelVault(
  value: AppOwnedVaultQuarantine | null,
): void {
  if (!value || !existsSync(value.quarantine)) return;
  if (existsSync(value.source)) {
    throw new Error('Could not restore the app-owned Vault because its original path was recreated.');
  }
  renameSync(value.quarantine, value.source);
}

export function discardAppOwnedNovelVault(
  value: AppOwnedVaultQuarantine | null,
): void {
  if (!value) return;
  rmSync(value.quarantine, { recursive: true, force: true });
}
