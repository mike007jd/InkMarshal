import 'server-only';

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { resolveLocalDbDir } from '@/lib/db-local-path';

export interface AppOwnedVaultQuarantine {
  source: string;
  quarantine: string;
  parent: string;
  sourceName: string;
  quarantineName: string;
  parentDev: string;
  parentIno: string;
}

type DirectoryIdentity = {
  realPath: string;
  dev: string;
  ino: string;
};

/**
 * Node has no public renameat/unlinkat API. Run the tiny rename/delete in a
 * child whose cwd is the validated parent, then verify that cwd's device and
 * inode before touching a relative name. A rename/symlink swap either fails
 * the identity check or leaves the child anchored to the original directory.
 */
const ANCHORED_DIR_HELPER_SOURCE = String.raw`
const fs = require('node:fs');
const [op, expectedDev, expectedIno, fromName, toName] = process.argv.slice(1);

function fail(message) {
  process.stderr.write(String(message).slice(0, 4000));
  process.exit(1);
}

function validName(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('/')
    && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(value)
    && value !== '.'
    && value !== '..';
}

try {
  const cwd = fs.lstatSync('.');
  if (!cwd.isDirectory() || String(cwd.dev) !== expectedDev || String(cwd.ino) !== expectedIno) {
    fail('Anchored Vault parent identity changed');
  }
  if (!validName(fromName)) fail('Invalid Vault directory name');
  if (op === 'rename') {
    if (!validName(toName)) fail('Invalid Vault quarantine name');
    const current = fs.lstatSync(fromName);
    if (current.isSymbolicLink() || !current.isDirectory()) {
      fail('Invalid app-owned Vault directory');
    }
    if (fs.existsSync(toName)) fail('Vault quarantine path already exists');
    fs.renameSync(fromName, toName);
    process.stdout.write('{}');
  } else if (op === 'delete') {
    const current = fs.lstatSync(fromName);
    if (current.isSymbolicLink()) fail('Invalid Vault quarantine path');
    if (!current.isDirectory()) fail('Invalid Vault quarantine path');
    fs.rmSync(fromName, { recursive: true, force: false });
    process.stdout.write('{}');
  } else {
    fail('Invalid anchored Vault directory operation');
  }
} catch (error) {
  if (error && error.code === 'ENOENT' && op === 'delete') {
    process.stdout.write('{}');
  } else {
    fail(error && error.message ? error.message : error);
  }
}
`;

export const __appOwnedCleanupTest = {
  afterParentValidated: null as null | ((parent: string) => void),
};

function identifyDirectory(directory: string, label: string): DirectoryIdentity {
  const resolved = path.resolve(directory);
  const before = lstatSync(resolved);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`Invalid ${label}`);
  }
  const canonical = realpathSync(resolved);
  const identity = lstatSync(canonical);
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error(`Invalid ${label}`);
  }
  if (String(before.dev) !== String(identity.dev) || String(before.ino) !== String(identity.ino)) {
    throw new Error(`Invalid ${label}`);
  }
  return {
    realPath: canonical,
    dev: String(identity.dev),
    ino: String(identity.ino),
  };
}

function isSingleRelativeName(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function runAnchoredDirectoryHelper(
  parent: DirectoryIdentity,
  op: 'rename' | 'delete',
  fromName: string,
  toName = '',
): void {
  __appOwnedCleanupTest.afterParentValidated?.(parent.realPath);
  const result = spawnSync(process.execPath, [
    '-e',
    ANCHORED_DIR_HELPER_SOURCE,
    op,
    parent.dev,
    parent.ino,
    fromName,
    toName,
  ], {
    cwd: parent.realPath,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.error?.message || 'Anchored Vault directory helper failed')
        .toString()
        .slice(0, 4000),
    );
  }
}

function quarantineDirectChild(
  parentPath: string,
  childName: string,
  quarantinePrefix: string,
): AppOwnedVaultQuarantine | null {
  if (!isSingleRelativeName(childName)) return null;
  if (!existsSync(parentPath)) return null;
  const parent = identifyDirectory(parentPath, 'app-owned Vault parent');
  const source = path.join(parent.realPath, childName);
  if (!existsSync(source)) return null;
  const quarantineName = `${quarantinePrefix}${crypto.randomUUID()}`;
  if (!isSingleRelativeName(quarantineName)) {
    throw new Error('Invalid Vault quarantine name');
  }
  runAnchoredDirectoryHelper(parent, 'rename', childName, quarantineName);
  return {
    source,
    quarantine: path.join(parent.realPath, quarantineName),
    parent: parent.realPath,
    sourceName: childName,
    quarantineName,
    parentDev: parent.dev,
    parentIno: parent.ino,
  };
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
  const relative = path.relative(path.resolve(ownedRoot), requestedPath);
  if (!isSingleRelativeName(relative)) return null;
  return quarantineDirectChild(ownedRoot, relative, '.delete-');
}

/** Quarantines the app-owned `vaults/` root under the local library directory. */
export function quarantineAppOwnedVaultRoot(): AppOwnedVaultQuarantine | null {
  const dbDir = resolveLocalDbDir();
  return quarantineDirectChild(dbDir, 'vaults', '.vaults-clear-');
}

export function restoreAppOwnedVaultQuarantine(
  value: AppOwnedVaultQuarantine | null,
): void {
  if (!value) return;
  if (!existsSync(value.quarantine)) return;
  const parent = identifyDirectory(value.parent, 'app-owned Vault parent');
  if (parent.dev !== value.parentDev || parent.ino !== value.parentIno) {
    throw new Error('Could not restore the app-owned Vault because its parent identity changed.');
  }
  if (existsSync(path.join(parent.realPath, value.sourceName))) {
    throw new Error('Could not restore the app-owned Vault because its original path was recreated.');
  }
  runAnchoredDirectoryHelper(parent, 'rename', value.quarantineName, value.sourceName);
}

export function discardAppOwnedVaultQuarantine(
  value: AppOwnedVaultQuarantine | null,
): void {
  if (!value) return;
  if (!existsSync(value.quarantine)) return;
  const parent = identifyDirectory(value.parent, 'app-owned Vault parent');
  if (parent.dev !== value.parentDev || parent.ino !== value.parentIno) {
    throw new Error('Could not discard the Vault quarantine because its parent identity changed.');
  }
  runAnchoredDirectoryHelper(parent, 'delete', value.quarantineName);
}
