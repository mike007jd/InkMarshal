#!/usr/bin/env node
/*
 * Streaming raw tar.gz member checker for the macOS updater archive.
 *
 * macOS bsdtar listings hide AppleDouble (`._*`) members by default, but the
 * Rust `tar` crate used by Tauri sees every header. Tauri then `skip(1)` on
 * each path and unpacks into a `tauri_updated_app*` temp directory — a root
 * `._InkMarshal.app` becomes an empty relative path and fails unpack.
 *
 * This gate streams gzip → 512-byte tar blocks, never buffering the full
 * uncompressed archive, and rejects metadata junk before Minisign signing.
 */
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

export const UPDATER_APP_ROOT = 'InkMarshal.app';
export const REQUIRED_UPDATER_MEMBERS = [
  `${UPDATER_APP_ROOT}/Contents/Info.plist`,
  `${UPDATER_APP_ROOT}/Contents/MacOS/inkmarshal-desktop`,
  `${UPDATER_APP_ROOT}/Contents/_CodeSignature/CodeResources`,
];

const TAR_BLOCK = 512;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_FAILURES = 25;

/**
 * @param {string} archivePath
 * @returns {Promise<{ members: string[] }>}
 */
export async function listUpdaterArchiveMembers(archivePath) {
  const gunzip = createGunzip();
  const input = createReadStream(archivePath);
  input.on('error', (error) => gunzip.destroy(error));
  input.pipe(gunzip);

  const reader = createByteReader(gunzip);
  const members = [];
  let pendingLongName = null;
  let pendingPax = null;

  try {
    for (;;) {
      const header = await reader.read(TAR_BLOCK);
      if (!header) break;
      if (isZeroBlock(header)) {
        const trailer = await reader.read(TAR_BLOCK);
        if (!trailer || !isZeroBlock(trailer)) {
          throw new Error('updater archive is missing its second zero trailer block');
        }
        break;
      }

      if (!verifyTarChecksum(header)) {
        throw new Error('updater archive contains a tar header with an invalid checksum');
      }

      const size = parseOctalField(header.subarray(124, 136), 'size');
      const typeflag = String.fromCharCode(header[156] || 0);
      const magic = header.subarray(257, 262).toString('latin1');
      if (magic !== 'ustar' && magic !== '\0\0\0\0\0') {
        throw new Error(`updater archive uses unsupported tar magic ${JSON.stringify(magic)}`);
      }

      if (typeflag === 'L' || typeflag === 'K') {
        if (size > MAX_METADATA_BYTES) {
          throw new Error('updater archive contains oversized GNU metadata');
        }
        const payload = await readPaddedPayload(reader, size);
        const decoded = payload.toString('utf8').replace(/\0+$/, '');
        if (typeflag === 'L') {
          if (pendingPax?.path) {
            throw new Error('updater archive mixes GNU and PAX path overrides');
          }
          pendingLongName = decoded;
        }
        continue;
      }

      if (typeflag === 'x' || typeflag === 'g' || typeflag === 'X') {
        if (size > MAX_METADATA_BYTES) {
          throw new Error('updater archive contains oversized PAX metadata');
        }
        const payload = await readPaddedPayload(reader, size);
        const pax = parsePaxHeader(payload);
        if (Object.hasOwn(pax, 'size')) {
          // Rust tar applies PAX size to the following payload boundary. A
          // second parser must either implement identical semantics or reject
          // it, otherwise a hidden header can bypass this gate.
          throw new Error('updater archive uses a forbidden PAX size override');
        }
        if (typeflag === 'g') {
          if (Object.hasOwn(pax, 'path')) {
            throw new Error('updater archive uses a forbidden global PAX path override');
          }
        } else {
          if (pax.path && pendingLongName !== null) {
            throw new Error('updater archive mixes GNU and PAX path overrides');
          }
          pendingPax = pax;
        }
        continue;
      }

      const name = pendingPax?.path ?? pendingLongName ?? readTarName(header);
      pendingLongName = null;
      pendingPax = null;
      const normalized = normalizeMemberName(name);
      if (normalized) members.push(normalized);
      await skipPaddedPayload(reader, size);
    }
  } finally {
    reader.destroy();
    input.destroy();
  }

  return { members };
}

/**
 * @param {string} archivePath
 * @returns {Promise<void>}
 */
export async function assertUpdaterArchiveClean(archivePath) {
  const { members } = await listUpdaterArchiveMembers(archivePath);
  const failures = inspectUpdaterArchiveMembers(members);
  if (failures.length > 0) {
    throw new Error(`updater archive rejected:\n- ${failures.join('\n- ')}`);
  }
}

/**
 * @param {string[]} members
 * @returns {string[]}
 */
export function inspectUpdaterArchiveMembers(members) {
  const failures = [];
  const addFailure = (message) => {
    if (failures.length < MAX_FAILURES && !failures.includes(message)) failures.push(message);
  };
  if (members.length === 0) {
    addFailure('archive has no members');
    return failures;
  }

  const roots = new Set();
  for (const member of members) {
    if (!member || member.startsWith('/') || member.includes('\0') || member.includes('\\')) {
      addFailure(`unsafe member path: ${safeMemberLabel(member)}`);
      continue;
    }
    const parts = member.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
      addFailure(`path traversal member: ${safeMemberLabel(member)}`);
      continue;
    }

    roots.add(parts[0]);

    if (parts[0] !== UPDATER_APP_ROOT) {
      addFailure(`unexpected root member: ${safeMemberLabel(parts[0])}`);
    }

    for (const part of parts) {
      if (part === '__MACOSX') {
        addFailure('__MACOSX metadata directory is forbidden');
      }
      if (part === '.DS_Store') {
        addFailure('.DS_Store member is forbidden');
      }
      if (part.startsWith('._')) {
        addFailure(`AppleDouble member is forbidden: ${safeMemberLabel(member)}`);
      }
    }
  }

  if (roots.size !== 1 || !roots.has(UPDATER_APP_ROOT)) {
    addFailure(
      `archive must contain exactly one ${UPDATER_APP_ROOT} root (found ${[...roots].join(', ') || 'none'})`,
    );
  }

  const memberSet = new Set(members);
  for (const required of REQUIRED_UPDATER_MEMBERS) {
    if (!memberSet.has(required)) {
      addFailure(`missing required member for signed Tauri shape: ${required}`);
    }
  }

  return failures;
}

function normalizeMemberName(name) {
  return String(name || '')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

function parsePaxHeader(payload) {
  const fields = Object.create(null);
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space === -1) throw new Error('updater archive contains malformed PAX metadata');
    const lengthText = payload.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) {
      throw new Error('updater archive contains malformed PAX record length');
    }
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (end > payload.length || payload[end - 1] !== 0x0a) {
      throw new Error('updater archive contains truncated PAX metadata');
    }
    const record = payload.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('updater archive contains malformed PAX record');
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return fields;
}

function safeMemberLabel(value) {
  const text = String(value || '');
  if (text.length <= 120) return text;
  return `${text.slice(0, 117)}...`;
}

function readTarName(header) {
  const prefix = readNullTerminated(header.subarray(345, 500));
  const name = readNullTerminated(header.subarray(0, 100));
  return prefix ? `${prefix}/${name}` : name;
}

function readNullTerminated(buffer) {
  const end = buffer.indexOf(0);
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString('utf8');
}

function parseOctalField(buffer, label) {
  const text = readNullTerminated(buffer).trim();
  if (!text) return 0;
  // Some writers store binary size in the high bit; reject non-octal here.
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`invalid tar ${label} field`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`invalid tar ${label} field`);
  }
  return value;
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function verifyTarChecksum(header) {
  const storedText = readNullTerminated(header.subarray(148, 156)).trim();
  if (!/^[0-7]+$/.test(storedText)) return false;
  const stored = Number.parseInt(storedText, 8);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 32 : header[i];
  }
  return sum === stored;
}

function paddedSize(size) {
  return size + ((TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK);
}

async function readPaddedPayload(reader, size) {
  const total = paddedSize(size);
  if (total === 0) return Buffer.alloc(0);
  const data = await reader.read(total);
  if (!data || data.length !== total) {
    throw new Error('updater archive ended while reading member payload');
  }
  return data.subarray(0, size);
}

async function skipPaddedPayload(reader, size) {
  const total = paddedSize(size);
  if (total === 0) return;
  // Skip in chunks so a huge member never materializes in RAM.
  let remaining = total;
  while (remaining > 0) {
    const take = Math.min(remaining, 1024 * 1024);
    const chunk = await reader.read(take);
    if (!chunk || chunk.length !== take) {
      throw new Error('updater archive ended while skipping member payload');
    }
    remaining -= take;
  }
}

function createByteReader(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  let chunk = Buffer.alloc(0);
  let offset = 0;
  let ended = false;

  return {
    async read(need) {
      const output = Buffer.allocUnsafe(need);
      let written = 0;
      while (written < need) {
        if (offset >= chunk.length) {
          if (ended) break;
          const next = await iterator.next();
          if (next.done) {
            ended = true;
            break;
          }
          chunk = Buffer.from(next.value);
          offset = 0;
          continue;
        }
        const available = Math.min(need - written, chunk.length - offset);
        chunk.copy(output, written, offset, offset + available);
        written += available;
        offset += available;
      }
      if (written === 0 && ended) return null;
      if (written !== need) {
        throw new Error(`updater archive ended mid-read (needed ${need} bytes, received ${written})`);
      }
      return output;
    },
    destroy() {
      stream.destroy();
    },
  };
}

async function main(argv) {
  const archivePath = argv[0];
  if (!archivePath) {
    console.error('usage: verify-updater-archive.mjs <archive.tar.gz>');
    process.exit(2);
  }
  await assertUpdaterArchiveClean(archivePath);
  console.log(`Updater archive OK: ${archivePath}`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
