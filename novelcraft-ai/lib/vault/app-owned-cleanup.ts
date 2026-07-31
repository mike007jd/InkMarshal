import 'server-only';

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  quarantineDev: string;
  quarantineIno: string;
  intentPath: string;
}

type DirectoryIdentity = {
  realPath: string;
  dev: string;
  ino: string;
};

type VaultCleanupIntentKind = 'novel' | 'library-root';

interface VaultCleanupIntent {
  version: 1;
  kind: VaultCleanupIntentKind;
  sourceName: string;
  quarantineName: string;
  novelId?: string;
}

const CLEANUP_INTENT_PREFIX = '.vault-cleanup-intent-';
const MAX_CLEANUP_INTENT_BYTES = 16 * 1024;
const activeCleanupIntents = new Set<string>();

/**
 * Node has no public renameat/unlinkat API. Run the tiny rename/delete in a
 * child whose cwd is the validated parent, then verify that cwd's device and
 * inode before touching a relative name. A rename/symlink swap either fails
 * the identity check or leaves the child anchored to the original directory.
 */
const ANCHORED_DIR_HELPER_SOURCE = String.raw`
const fs = require('node:fs');
const [
  op,
  expectedDev,
  expectedIno,
  fromName,
  toName,
  expectedFromDev,
  expectedFromIno,
] = process.argv.slice(1);

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
  const current = fs.lstatSync(fromName);
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || String(current.dev) !== expectedFromDev
    || String(current.ino) !== expectedFromIno
  ) {
    fail('App-owned Vault directory identity changed');
  }
  if (op === 'rename') {
    if (!validName(toName)) fail('Invalid Vault quarantine name');
    if (fs.existsSync(toName)) fail('Vault quarantine path already exists');
    fs.renameSync(fromName, toName);
    const moved = fs.lstatSync(toName);
    if (
      moved.isSymbolicLink()
      || !moved.isDirectory()
      || String(moved.dev) !== expectedFromDev
      || String(moved.ino) !== expectedFromIno
    ) {
      fail('App-owned Vault directory changed during quarantine');
    }
    process.stdout.write('{}');
  } else if (op === 'delete') {
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
  forgetActiveIntent(intentPath: string): void {
    activeCleanupIntents.delete(intentPath);
  },
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

function normalizeVaultReference(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    try {
      return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function createCleanupIntent(
  dbDir: string,
  kind: VaultCleanupIntentKind,
  sourceName: string,
  quarantineName: string,
  novelId?: string,
): string {
  const intentPath = path.join(dbDir, `${CLEANUP_INTENT_PREFIX}${crypto.randomUUID()}.json`);
  const tempPath = `${intentPath}.tmp-${crypto.randomUUID()}`;
  const fd = openSync(tempPath, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({
      version: 1,
      kind,
      sourceName,
      quarantineName,
      novelId,
    } satisfies VaultCleanupIntent)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, intentPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
  activeCleanupIntents.add(intentPath);
  return intentPath;
}

function removeCleanupIntent(intentPath: string): void {
  activeCleanupIntents.delete(intentPath);
  rmSync(intentPath, { force: true });
}

function runAnchoredDirectoryHelper(
  parent: DirectoryIdentity,
  op: 'rename' | 'delete',
  fromName: string,
  fromIdentity: Pick<DirectoryIdentity, 'dev' | 'ino'>,
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
    fromIdentity.dev,
    fromIdentity.ino,
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
  kind: VaultCleanupIntentKind,
  novelId?: string,
): AppOwnedVaultQuarantine | null {
  if (!isSingleRelativeName(childName)) return null;
  if (!existsSync(parentPath)) return null;
  const parent = identifyDirectory(parentPath, 'app-owned Vault parent');
  const source = path.join(parent.realPath, childName);
  if (!existsSync(source)) return null;
  const sourceIdentity = identifyDirectory(source, 'app-owned Vault directory');
  const quarantineName = `${quarantinePrefix}${crypto.randomUUID()}`;
  if (!isSingleRelativeName(quarantineName)) {
    throw new Error('Invalid Vault quarantine name');
  }
  const intentPath = createCleanupIntent(
    resolveLocalDbDir(),
    kind,
    childName,
    quarantineName,
    novelId,
  );
  try {
    runAnchoredDirectoryHelper(parent, 'rename', childName, sourceIdentity, quarantineName);
  } catch (error) {
    // A post-rename identity check can fail after the atomic move completed.
    // Keep the durable intent in that case so startup can restore from the
    // quarantine instead of orphaning it; no DB mutation has happened yet.
    if (existsSync(path.join(parent.realPath, quarantineName))) {
      activeCleanupIntents.delete(intentPath);
    } else {
      removeCleanupIntent(intentPath);
    }
    throw error;
  }
  return {
    source,
    quarantine: path.join(parent.realPath, quarantineName),
    parent: parent.realPath,
    sourceName: childName,
    quarantineName,
    parentDev: parent.dev,
    parentIno: parent.ino,
    quarantineDev: sourceIdentity.dev,
    quarantineIno: sourceIdentity.ino,
    intentPath,
  };
}

/**
 * Moves one app-managed per-novel Vault aside before its database row is
 * deleted. External roots and symlink escapes are deliberately ignored.
 */
export function quarantineAppOwnedNovelVault(
  vaultPath: string | null | undefined,
  novelId: string,
): AppOwnedVaultQuarantine | null {
  if (!vaultPath) return null;
  const ownedRoot = path.join(resolveLocalDbDir(), 'vaults');
  const requestedPath = path.resolve(vaultPath);
  const relative = path.relative(path.resolve(ownedRoot), requestedPath);
  if (!isSingleRelativeName(relative)) return null;
  return quarantineDirectChild(ownedRoot, relative, `.delete-${relative}-`, 'novel', novelId);
}

/** Quarantines the app-owned `vaults/` root under the local library directory. */
export function quarantineAppOwnedVaultRoot(): AppOwnedVaultQuarantine | null {
  const dbDir = resolveLocalDbDir();
  return quarantineDirectChild(dbDir, 'vaults', '.vaults-clear-', 'library-root');
}

export function restoreAppOwnedVaultQuarantine(
  value: AppOwnedVaultQuarantine | null,
): void {
  if (!value) return;
  const parent = identifyDirectory(value.parent, 'app-owned Vault parent');
  if (parent.dev !== value.parentDev || parent.ino !== value.parentIno) {
    throw new Error('Could not restore the app-owned Vault because its parent identity changed.');
  }
  if (!existsSync(value.quarantine)) {
    removeCleanupIntent(value.intentPath);
    return;
  }
  if (existsSync(path.join(parent.realPath, value.sourceName))) {
    throw new Error('Could not restore the app-owned Vault because its original path was recreated.');
  }
  runAnchoredDirectoryHelper(
    parent,
    'rename',
    value.quarantineName,
    { dev: value.quarantineDev, ino: value.quarantineIno },
    value.sourceName,
  );
  removeCleanupIntent(value.intentPath);
}

export function discardAppOwnedVaultQuarantine(
  value: AppOwnedVaultQuarantine | null,
): void {
  if (!value) return;
  const parent = identifyDirectory(value.parent, 'app-owned Vault parent');
  if (parent.dev !== value.parentDev || parent.ino !== value.parentIno) {
    throw new Error('Could not discard the Vault quarantine because its parent identity changed.');
  }
  if (!existsSync(value.quarantine)) {
    removeCleanupIntent(value.intentPath);
    return;
  }
  runAnchoredDirectoryHelper(
    parent,
    'delete',
    value.quarantineName,
    { dev: value.quarantineDev, ino: value.quarantineIno },
  );
  removeCleanupIntent(value.intentPath);
}

function readCleanupIntent(intentPath: string): VaultCleanupIntent | null {
  try {
    const stat = lstatSync(intentPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CLEANUP_INTENT_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(intentPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Partial<VaultCleanupIntent>;
    if (
      value.version !== 1
      || (value.kind !== 'novel' && value.kind !== 'library-root')
      || !isSingleRelativeName(value.sourceName ?? '')
      || !isSingleRelativeName(value.quarantineName ?? '')
    ) return null;
    if (value.kind === 'library-root' && value.sourceName !== 'vaults') return null;
    if (value.kind === 'novel' && !value.quarantineName!.startsWith(`.delete-${value.sourceName}-`)) {
      return null;
    }
    if (
      value.kind === 'novel'
      && (
        typeof value.novelId !== 'string'
        || value.novelId.length === 0
        || value.novelId.length > 200
        || /[\u0000-\u001f\u007f]/.test(value.novelId)
      )
    ) return null;
    if (value.kind === 'library-root' && !value.quarantineName!.startsWith('.vaults-clear-')) {
      return null;
    }
    return value as VaultCleanupIntent;
  } catch {
    return null;
  }
}

/** Completes app-owned Vault cleanup interrupted by a process exit. */
export function reconcileAppOwnedVaultCleanupIntents(db: {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}): void {
  const dbDir = resolveLocalDbDir();
  if (!existsSync(dbDir)) return;
  for (const entry of readdirSync(dbDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(CLEANUP_INTENT_PREFIX) || !entry.name.endsWith('.json')) {
      continue;
    }
    const intentPath = path.join(dbDir, entry.name);
    if (activeCleanupIntents.has(intentPath)) continue;
    const intent = readCleanupIntent(intentPath);
    if (!intent) continue;
    try {
      const parentPath = intent.kind === 'novel' ? path.join(dbDir, 'vaults') : dbDir;
      if (!existsSync(parentPath)) continue;
      const parent = identifyDirectory(parentPath, 'app-owned Vault parent');
      const quarantine = path.join(parent.realPath, intent.quarantineName);
      if (!existsSync(quarantine)) {
        removeCleanupIntent(intentPath);
        continue;
      }
      const quarantineIdentity = identifyDirectory(quarantine, 'app-owned Vault quarantine');
      const handle: AppOwnedVaultQuarantine = {
        source: path.join(parent.realPath, intent.sourceName),
        quarantine,
        parent: parent.realPath,
        sourceName: intent.sourceName,
        quarantineName: intent.quarantineName,
        parentDev: parent.dev,
        parentIno: parent.ino,
        quarantineDev: quarantineIdentity.dev,
        quarantineIno: quarantineIdentity.ino,
        intentPath,
      };
      const targetPath = normalizeVaultReference(path.join(parent.realPath, intent.sourceName));
      const targetNovelExists = intent.kind === 'novel'
        && Boolean(db.prepare('SELECT 1 FROM novels WHERE id = ? LIMIT 1').get(intent.novelId));
      const sharedNovelReference = intent.kind === 'novel'
        && (db.prepare('SELECT id, vault_path FROM novels WHERE vault_path IS NOT NULL').all() as Array<{
          id: string;
          vault_path: string;
        }>).some(row => (
          row.id !== intent.novelId
          && normalizeVaultReference(row.vault_path) === targetPath
        ));
      const sharedSeriesReference = intent.kind === 'novel'
        && (db.prepare('SELECT vault_path FROM series WHERE vault_path IS NOT NULL').all() as Array<{
          vault_path: string;
        }>).some(row => normalizeVaultReference(row.vault_path) === targetPath);
      const libraryStillPopulated = intent.kind === 'library-root'
        && Boolean(
          db.prepare('SELECT 1 FROM novels LIMIT 1').get()
          || db.prepare('SELECT 1 FROM series LIMIT 1').get(),
        );
      const shouldRestore = targetNovelExists
        || sharedNovelReference
        || sharedSeriesReference
        || libraryStillPopulated;
      if (shouldRestore) restoreAppOwnedVaultQuarantine(handle);
      else discardAppOwnedVaultQuarantine(handle);
    } catch (error) {
      console.warn('[vault-cleanup] interrupted cleanup will retry', error);
    }
  }
}
