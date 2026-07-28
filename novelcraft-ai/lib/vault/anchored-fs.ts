import 'server-only';

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
] = process.argv.slice(1);
const allowedDirs = new Set(allowedDirsRaw.split(','));
const maxEntry = Number(maxEntryRaw);
const maxFiles = Number(maxFilesRaw);
const maxList = Number(maxListRaw);

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
      const tmp = '.' + name + '.' + process.pid + '.' + require('node:crypto').randomUUID() + '.tmp';
      let fd;
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
        fs.renameSync(tmp, name);
        process.stdout.write('{}');
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch {}
        }
        try { fs.unlinkSync(tmp); } catch {}
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

export async function writeAnchoredVaultEntry(
  rootPath: string,
  relPath: string,
  content: string,
): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > MAX_ENTRY_BYTES) {
    throw new Error('Vault markdown is too large');
  }
  const [directory, filename] = validateEntryPath(relPath);
  const root = await identifyRoot(rootPath);
  await runAnchoredHelper(root, 'write', directory, filename, content);
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
