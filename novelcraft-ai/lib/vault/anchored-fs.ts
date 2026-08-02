import 'server-only';

import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { isVaultEntryPath, VAULT_ENTRY_DIRS } from '@/lib/vault/entry';

const MAX_ENTRY_BYTES = 128 * 1024;
const MAX_LIST_FILES = 4_096;
const MAX_LIST_BYTES = 32 * 1024 * 1024;
const MAX_HELPER_OUTPUT_BYTES = MAX_LIST_BYTES * 2;

type DirectoryIdentity = {
  realPath: string;
  dev: string;
  ino: string;
};

type AnchoredListEntry = {
  name: string;
  content: string;
};

/**
 * Node has no public openat/renameat/unlinkat API. Run the tiny operation in a
 * child whose cwd is the validated directory, then verify that cwd's device and
 * inode before touching a relative filename. A rename/symlink swap either fails
 * the identity check or leaves the child anchored to the original directory.
 */
const ANCHORED_HELPER_SOURCE = String.raw`
const fs = require('node:fs');
const [
  op,
  directory,
  name,
  expectedDev,
  expectedIno,
  allowedDirsRaw,
  maxEntryRaw,
  maxFilesRaw,
  maxListRaw,
  expectedContentHash,
  mutateTargetBeforeInstallPath,
  recreateTargetAfterDisplacePath,
  mutateOpenTargetAfterInstallPath,
  exitAfterDisplaceRaw,
  exitAfterInstallRaw,
  exitAfterRecoveryLinkRaw,
] = process.argv.slice(1);
const allowedDirs = new Set(allowedDirsRaw.split(','));
const maxEntry = Number(maxEntryRaw);
const maxFiles = Number(maxFilesRaw);
const maxList = Number(maxListRaw);
const crypto = require('node:crypto');

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readRegularFileSnapshot(filename) {
  let fd;
  try {
    fd = fs.openSync(
      filename,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail('Invalid Vault entry file');
    if (stat.size > maxEntry) fail('Vault markdown is too large');
    return {
      content: fs.readFileSync(fd),
      dev: String(stat.dev),
      ino: String(stat.ino),
    };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readRegularFile(filename) {
  return readRegularFileSnapshot(filename).content;
}

function writeRegularFileTruncate(filename, buf) {
  let fd;
  try {
    fd = fs.openSync(
      filename,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail('Invalid Vault entry file');
    let offset = 0;
    while (offset < buf.length) {
      offset += fs.writeSync(fd, buf, offset, buf.length - offset);
    }
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function restoreRegularFileWithoutOverwrite(displaced, filename) {
  try {
    fs.linkSync(displaced, filename);
  } catch (error) {
    if (error && error.code === 'EEXIST') return false;
    throw error;
  }
  if (exitAfterRecoveryLinkRaw === '1') process.exit(77);
  // The canonical hardlink is already durable enough for retry semantics. If
  // sidecar cleanup fails, keeping a duplicate is safer than risking data loss.
  try { fs.unlinkSync(displaced); } catch {}
  return true;
}

function recoveryFilesFor(filename) {
  const prefix = '.' + filename + '.';
  return fs.readdirSync('.')
    .filter(entry => entry.startsWith(prefix) && entry.endsWith('.displaced'))
    .sort();
}

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

function enterEntryDirectory(create) {
  if (!validName(directory) || !allowedDirs.has(directory)) {
    fail('Invalid Vault entry directory');
  }
  let expected;
  try {
    expected = fs.lstatSync(directory);
    if (expected.isSymbolicLink()) fail('Invalid Vault entry directory');
    if (!expected.isDirectory()) {
      if (create) fail('Invalid Vault entry directory');
      return false;
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    if (!create) return false;
    fs.mkdirSync(directory);
    expected = fs.lstatSync(directory);
    if (expected.isSymbolicLink() || !expected.isDirectory()) {
      fail('Invalid Vault entry directory');
    }
  }
  // chdir resolves from the already-validated root cwd. Verify the identity
  // recorded immediately before chdir so a concurrent child swap cannot move
  // this helper into an attacker-controlled directory.
  process.chdir(directory);
  const cwd = fs.lstatSync('.');
  if (
    !cwd.isDirectory()
    || String(cwd.dev) !== String(expected.dev)
    || String(cwd.ino) !== String(expected.ino)
  ) {
    fail('Anchored Vault directory identity changed');
  }
  return true;
}

try {
  const cwd = fs.lstatSync('.');
  if (!cwd.isDirectory() || String(cwd.dev) !== expectedDev || String(cwd.ino) !== expectedIno) {
    fail('Anchored Vault root identity changed');
  }
  if (op !== 'write' && op !== 'delete' && op !== 'list') {
    fail('Invalid anchored Vault operation');
  }
  const present = enterEntryDirectory(op === 'write');
  if (!present) {
    process.stdout.write(op === 'list' ? '[]' : '{}');
  } else if (op === 'write') {
    if (!validName(name) || !name.endsWith('.md')) fail('Invalid Vault entry filename');
    const chunks = [];
    let size = 0;
    process.stdin.on('data', chunk => {
      size += chunk.length;
      if (size > maxEntry) fail('Vault markdown is too large');
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      const content = Buffer.concat(chunks);
      const contentHash = sha256Hex(content);
      const baseline = typeof expectedContentHash === 'string' ? expectedContentHash : '';

      // A killed helper can leave the previous canonical inode under a recovery
      // name. Never reinterpret that state as an ordinary missing-file create.
      const recoveryFiles = recoveryFilesFor(name);
      if (recoveryFiles.length > 1) {
        fail('Vault markdown conflict: multiple unresolved recovery sidecars');
      }
      if (recoveryFiles.length === 1) {
        const recovery = recoveryFiles[0];
        const recoverySnapshot = readRegularFileSnapshot(recovery);
        let canonicalSnapshot = null;
        try {
          canonicalSnapshot = readRegularFileSnapshot(name);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }
        if (
          canonicalSnapshot
          && canonicalSnapshot.dev === recoverySnapshot.dev
          && canonicalSnapshot.ino === recoverySnapshot.ino
        ) {
          // Crash between recovery hardlink and sidecar unlink: both names are
          // the same inode, so removing the duplicate cannot discard any bytes.
          fs.unlinkSync(recovery);
        } else if (baseline && sha256Hex(recoverySnapshot.content) === baseline) {
          // The recovery inode still equals the known App baseline. It carries
          // no unobserved external bytes, so it is safe to discard before the
          // normal CAS classification below.
          fs.unlinkSync(recovery);
        } else if (!canonicalSnapshot) {
          if (!restoreRegularFileWithoutOverwrite(recovery, name)) {
            fail('Vault markdown conflict: recovery restore lost no-replace race');
          }
        } else {
          // Canonical and recovery contain two independently reachable versions.
          // Keep both until an explicit resolution; never silently choose one.
          fail('Vault markdown conflict: unresolved external recovery sidecar');
        }
      }

      // Fail closed for unknown baselines on divergent existing files: schema
      // upgrades leave mirror_content_hash NULL and must never authorize a
      // compatibility blind-replace of established Markdown.
      function classifyExisting(buf) {
        if (!buf) return 'missing';
        if (Buffer.compare(buf, content) === 0) return 'unchanged';
        if (!baseline || sha256Hex(buf) !== baseline) return 'conflict';
        return 'replaceable';
      }

      let current = null;
      try {
        current = readRegularFile(name);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      const initial = classifyExisting(current);
      if (initial === 'unchanged') {
        process.stdout.write(JSON.stringify({ result: 'unchanged', contentHash }));
        return;
      }
      if (initial === 'conflict') {
        fail('Vault markdown conflict: external edit since baseline');
      }

      const tmp = '.' + name + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
      const displaced = '.' + name + '.' + process.pid + '.' + crypto.randomUUID() + '.displaced';
      let fd;
      let testOldFd;
      let displacedHeld = false;
      let displacedRestorable = false;
      try {
        fd = fs.openSync(
          tmp,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
        let offset = 0;
        while (offset < content.length) {
          offset += fs.writeSync(fd, content, offset, content.length - offset);
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;

        // Final install boundary (test-only): mutate the live target after the
        // last pre-install validation point above and before displacement.
        if (typeof mutateTargetBeforeInstallPath === 'string'
          && mutateTargetBeforeInstallPath.length > 0) {
          writeRegularFileTruncate(name, fs.readFileSync(mutateTargetBeforeInstallPath));
        }
        if (typeof mutateOpenTargetAfterInstallPath === 'string'
          && mutateOpenTargetAfterInstallPath.length > 0) {
          testOldFd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
        }

        // Displace whatever exists at replacement time so those bytes are never
        // discarded by a rename-over. Then install with link (no-replace).
        try {
          fs.renameSync(name, displaced);
          displacedHeld = true;
          if (exitAfterDisplaceRaw === '1') process.exit(75);
        } catch (error) {
          if (!error || error.code !== 'ENOENT') throw error;
        }

        // Final no-replace boundary (test-only): model an editor recreating
        // the canonical path after displacement (or a missing-target check)
        // but before App install.
        if (typeof recreateTargetAfterDisplacePath === 'string'
          && recreateTargetAfterDisplacePath.length > 0) {
          writeRegularFileTruncate(name, fs.readFileSync(recreateTargetAfterDisplacePath));
        }

        if (displacedHeld) {
          let displacedBuf;
          try {
            displacedBuf = readRegularFile(displaced);
            displacedRestorable = true;
          } catch (error) {
            // The displaced object is no longer a validated regular file. Do
            // not restore it to the canonical Markdown path; keep the sidecar
            // as recovery evidence and fail closed.
            throw error;
          }
          const displacedClass = classifyExisting(displacedBuf);
          if (displacedClass === 'unchanged') {
            const restored = restoreRegularFileWithoutOverwrite(displaced, name);
            if (restored) {
              displacedHeld = false;
              displacedRestorable = false;
            }
            try { fs.unlinkSync(tmp); } catch {}
            if (!restored) {
              // A new canonical path won the race. The displaced bytes equal
              // the App projection and remain recoverable from SQLite.
              try { fs.unlinkSync(displaced); } catch {}
              displacedHeld = false;
              displacedRestorable = false;
              fail('Vault markdown conflict: external edit since baseline');
            }
            process.stdout.write(JSON.stringify({ result: 'unchanged', contentHash }));
            return;
          }
          if (displacedClass === 'conflict') {
            const restored = restoreRegularFileWithoutOverwrite(displaced, name);
            if (restored) {
              displacedHeld = false;
              displacedRestorable = false;
            }
            try { fs.unlinkSync(tmp); } catch {}
            // When restore is blocked by a recreated canonical path, keep the
            // displaced external bytes as a durable recovery sidecar. Never
            // overwrite either external version.
            fail('Vault markdown conflict: external edit since baseline');
          }
        }

        // Missing target (or successfully displaced baseline match): create via
        // hardlink so a recreated name yields EEXIST instead of silent clobber.
        try {
          fs.linkSync(tmp, name);
        } catch (error) {
          if (error && error.code === 'EEXIST') {
            // Canonical path reappeared after displace — keep it. Displaced
            // bytes matched the App baseline, so they are recoverable from DB.
            if (displacedHeld) {
              try { fs.unlinkSync(displaced); } catch {}
              displacedHeld = false;
              displacedRestorable = false;
            }
            try { fs.unlinkSync(tmp); } catch {}
            fail('Vault markdown conflict: external edit since baseline');
          }
          if (displacedHeld) {
            try {
              if (restoreRegularFileWithoutOverwrite(displaced, name)) {
                displacedHeld = false;
                displacedRestorable = false;
              }
            } catch {}
          }
          throw error;
        }
        if (exitAfterInstallRaw === '1') process.exit(76);
        if (testOldFd !== undefined) {
          const mutation = fs.readFileSync(mutateOpenTargetAfterInstallPath);
          fs.ftruncateSync(testOldFd, 0);
          let offset = 0;
          while (offset < mutation.length) {
            offset += fs.writeSync(testOldFd, mutation, offset, mutation.length - offset);
          }
          fs.fsyncSync(testOldFd);
          fs.closeSync(testOldFd);
          testOldFd = undefined;
        }
        if (displacedHeld) {
          const finalDisplaced = readRegularFile(displaced);
          if (!baseline || sha256Hex(finalDisplaced) !== baseline) {
            try { fs.unlinkSync(tmp); } catch {}
            // The canonical path contains the App projection; the recovery
            // sidecar retains the late external write. Keep both and leave the
            // durable App outbox pending for explicit conflict resolution.
            fail('Vault markdown conflict: external edit through displaced file handle');
          }
        }
        try { fs.unlinkSync(tmp); } catch {}
        if (displacedHeld) {
          try { fs.unlinkSync(displaced); } catch {}
          displacedHeld = false;
          displacedRestorable = false;
        }
        process.stdout.write(JSON.stringify({ result: 'written', contentHash }));
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch {}
        }
        if (testOldFd !== undefined) {
          try { fs.closeSync(testOldFd); } catch {}
        }
        try { fs.unlinkSync(tmp); } catch {}
        if (displacedHeld && displacedRestorable) {
          try {
            if (restoreRegularFileWithoutOverwrite(displaced, name)) {
              displacedHeld = false;
              displacedRestorable = false;
            }
          } catch {
            // Leave displaced as a durable recovery copy if restore cannot land.
          }
        }
      }
    });
  } else if (op === 'delete') {
    if (!validName(name) || !name.endsWith('.md')) fail('Invalid Vault entry filename');
    try {
      const current = fs.lstatSync(name);
      if (current.isSymbolicLink() || !current.isFile()) fail('Invalid Vault entry file');
      fs.unlinkSync(name);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    process.stdout.write('{}');
  } else if (op === 'list') {
    const result = [];
    let total = 0;
    for (const entryName of fs.readdirSync('.').sort()) {
      if (!validName(entryName) || !entryName.endsWith('.md')) continue;
      let fd;
      try {
        fd = fs.openSync(
          entryName,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > maxEntry) fail('Invalid Vault bootstrap file: ' + entryName);
        const content = fs.readFileSync(fd, 'utf8');
        total += Buffer.byteLength(content, 'utf8');
        if (result.length >= maxFiles || total > maxList) fail('Vault bootstrap snapshot is too large');
        result.push({ name: entryName, content });
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
    process.stdout.write(JSON.stringify(result));
  } else {
    fail('Invalid anchored Vault operation');
  }
} catch (error) {
  fail(error && error.message ? error.message : error);
}
`;

export const __anchoredFsTest = {
  afterDirectoryValidated: null as null | ((directory: string) => Promise<void> | void),
  /**
   * Test-only: absolute path whose bytes are written onto the live target after
   * tmp fsync and before atomic displace/no-replace install.
   */
  mutateTargetBeforeInstallFile: null as string | null,
  /** Test-only bytes used to recreate the canonical path after displacement. */
  recreateTargetAfterDisplaceFile: null as string | null,
  /** Test-only bytes written through an fd opened before displacement. */
  mutateOpenTargetAfterInstallFile: null as string | null,
  /** Test-only crash injection immediately after canonical displacement. */
  exitAfterDisplace: false,
  /** Test-only crash injection after no-replace install, before cleanup. */
  exitAfterInstall: false,
  /** Test-only crash injection after recovery link, before sidecar unlink. */
  exitAfterRecoveryLink: false,
};

function validateEntryPath(relPath: string): [directory: string, filename: string] {
  if (!isVaultEntryPath(relPath) || path.isAbsolute(relPath) || relPath.includes('\\')) {
    throw new Error('Invalid vault entry path');
  }
  const parts = relPath.split('/');
  if (parts.length !== 2 || !VAULT_ENTRY_DIRS.has(parts[0])) {
    throw new Error('Invalid vault entry path');
  }
  return [parts[0], parts[1]];
}

async function identifyDirectory(directory: string, label: string): Promise<DirectoryIdentity> {
  const resolved = path.resolve(directory);
  const before = await lstat(resolved);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`Invalid ${label}`);
  }
  const canonical = await realpath(resolved);
  const identity = await lstat(canonical);
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

async function runAnchoredHelper(
  root: DirectoryIdentity,
  operation: 'write' | 'delete' | 'list',
  directory: string,
  name = '',
  input?: string,
  expectedContentHash = '',
): Promise<string> {
  await __anchoredFsTest.afterDirectoryValidated?.(root.realPath);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e',
      ANCHORED_HELPER_SOURCE,
      operation,
      directory,
      name,
      root.dev,
      root.ino,
      Array.from(VAULT_ENTRY_DIRS).join(','),
      String(MAX_ENTRY_BYTES),
      String(MAX_LIST_FILES),
      String(MAX_LIST_BYTES),
      expectedContentHash,
      __anchoredFsTest.mutateTargetBeforeInstallFile ?? '',
      __anchoredFsTest.recreateTargetAfterDisplaceFile ?? '',
      __anchoredFsTest.mutateOpenTargetAfterInstallFile ?? '',
      __anchoredFsTest.exitAfterDisplace ? '1' : '0',
      __anchoredFsTest.exitAfterInstall ? '1' : '0',
      __anchoredFsTest.exitAfterRecoveryLink ? '1' : '0',
    ], {
      cwd: root.realPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let timedOut = false;
    let stdinError: Error | null = null;
    let settled = false;
    const finish = (error: Error | null, output = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
        overflowed = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 8_192) stderr.push(chunk);
    });
    child.stdin.on('error', (error: Error) => {
      // A helper that rejects cwd identity may exit before consuming stdin.
      // Retain EPIPE for the close result instead of crashing the server.
      stdinError = error;
    });
    child.once('error', error => finish(error));
    child.once('close', code => {
      if (timedOut) {
        finish(new Error('Anchored Vault helper timed out'));
      } else if (overflowed) {
        finish(new Error('Anchored Vault helper output is too large'));
      } else if (code !== 0) {
        finish(new Error(
          Buffer.concat(stderr).toString('utf8')
          || stdinError?.message
          || 'Anchored Vault helper failed',
        ));
      } else if (stdinError) {
        finish(stdinError);
      } else {
        finish(null, Buffer.concat(stdout).toString('utf8'));
      }
    });
    child.stdin.end(input ?? '');
  });
}

async function identifyRoot(root: string): Promise<DirectoryIdentity> {
  return identifyDirectory(root, 'Vault root');
}

export type AnchoredVaultWriteResult =
  | { result: 'written'; contentHash: string }
  | { result: 'unchanged'; contentHash: string };

export class VaultMarkdownConflictError extends Error {
  constructor(message = 'Vault markdown conflict: external edit since baseline') {
    super(message);
    this.name = 'VaultMarkdownConflictError';
  }
}

export function isVaultMarkdownConflictError(error: unknown): boolean {
  return error instanceof VaultMarkdownConflictError
    || (error instanceof Error && error.message.includes('Vault markdown conflict:'));
}

/**
 * Project Markdown into an anchored Vault entry via displace + no-replace install.
 * Refuses divergent existing targets when the baseline is unknown/empty or no
 * longer matches (external edits stay on disk). Missing targets remain creatable.
 */
export async function writeAnchoredVaultEntry(
  rootPath: string,
  relPath: string,
  content: string,
  expectedContentHash?: string | null,
): Promise<AnchoredVaultWriteResult> {
  if (Buffer.byteLength(content, 'utf8') > MAX_ENTRY_BYTES) {
    throw new Error('Vault markdown is too large');
  }
  const [directory, filename] = validateEntryPath(relPath);
  const root = await identifyRoot(rootPath);
  try {
    const raw = await runAnchoredHelper(
      root,
      'write',
      directory,
      filename,
      content,
      expectedContentHash ?? '',
    );
    const parsed = JSON.parse(raw || '{}') as {
      result?: string;
      contentHash?: string;
    };
    if (
      (parsed.result === 'written' || parsed.result === 'unchanged')
      && typeof parsed.contentHash === 'string'
      && parsed.contentHash.length > 0
    ) {
      return { result: parsed.result, contentHash: parsed.contentHash };
    }
    // Legacy helper responses / empty objects are treated as a successful write
    // of the content we just projected.
    return {
      result: 'written',
      contentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  } catch (error) {
    if (isVaultMarkdownConflictError(error)) {
      throw error instanceof VaultMarkdownConflictError
        ? error
        : new VaultMarkdownConflictError(
          error instanceof Error ? error.message : undefined,
        );
    }
    throw error;
  }
}

export async function deleteAnchoredVaultEntry(
  rootPath: string,
  relPath: string,
): Promise<void> {
  const [directory, filename] = validateEntryPath(relPath);
  const root = await identifyRoot(rootPath);
  await runAnchoredHelper(root, 'delete', directory, filename);
}

export async function readAnchoredVaultMarkdown(
  rootPath: string,
): Promise<Array<{ path: string; content: string }>> {
  const root = await identifyRoot(rootPath);
  const files: Array<{ path: string; content: string }> = [];
  for (const directory of VAULT_ENTRY_DIRS) {
    const raw = await runAnchoredHelper(root, 'list', directory);
    const entries = JSON.parse(raw) as AnchoredListEntry[];
    for (const entry of entries) {
      const relPath = `${directory}/${entry.name}`;
      validateEntryPath(relPath);
      if (typeof entry.content !== 'string') {
        throw new Error('Invalid anchored Vault helper response');
      }
      files.push({ path: relPath, content: entry.content });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
