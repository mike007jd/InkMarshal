import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { resolveInkmarshalAppDir, resolveLocalDbDir } from '@/lib/db-local-path';
import { LOCAL_USER_ID } from '@/lib/local-user';
import {
  IMPORT_SESSION_TTL_MS,
  IMPORT_TOKEN_PATTERN,
  MAX_IMPORT_CHAPTERS,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_PARAGRAPHS,
  MAX_IMPORT_RECONSTRUCTED_BYTES,
  MAX_IMPORT_TITLE_CHARS,
} from '@/lib/import/limits';
import type { ImportSource } from '@/lib/import/types';

const IMPORT_SESSIONS_DIRNAME = 'import-sessions';
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

/** One stored segment: full paragraphs retained server-side only. */
export interface StoredImportSegment {
  id: string;
  title: string;
  volumeTitle: string | null;
  paragraphs: string[];
  wordCount: number;
  inferred: boolean;
}

export interface ImportSessionRecord {
  version: 1;
  token: string;
  ownerUserId: string;
  /** sha256 hex of INKMARSHAL_DESKTOP_SESSION, or a local-dev sentinel. */
  desktopSessionBinding: string;
  createdAt: string;
  expiresAt: string;
  source: ImportSource;
  basename: string;
  filename: string;
  suggestedTitle: string;
  segments: StoredImportSegment[];
}

interface StagedMeta {
  basename: string;
  stagedName: string;
  createdAtUnix?: number;
}

/**
 * Resolve the import-sessions root.
 *
 * Production/desktop matches Rust `inkmarshal_app_dir()/import-sessions`.
 * When `INKMARSHAL_DATA_DIR` is set (test/script isolation only), sessions
 * stay beside the test DB so suites never touch the real app tree.
 */
function resolveImportSessionsRoot(): string {
  if (process.env.INKMARSHAL_DATA_DIR?.trim()) {
    return path.join(resolveLocalDbDir(), IMPORT_SESSIONS_DIRNAME);
  }
  return path.join(resolveInkmarshalAppDir(), IMPORT_SESSIONS_DIRNAME);
}

export function desktopSessionBinding(): string {
  const token = process.env.INKMARSHAL_DESKTOP_SESSION?.trim();
  if (!token) return `local:${LOCAL_USER_ID}`;
  return createHash('sha256').update(token).digest('hex');
}

function assertValidImportToken(token: string): string {
  const t = (token ?? '').trim();
  if (!IMPORT_TOKEN_PATTERN.test(t)) {
    throw new Error('Import session token is invalid.');
  }
  return t;
}

/** Ensure `candidate` resolves inside `root` (after realpath when possible). */
function assertPathInside(root: string, candidate: string): string {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const rel = path.relative(rootResolved, candidateResolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Import session path escapes the owned directory.');
  }
  return candidateResolved;
}

export function sessionDirForToken(token: string): string {
  const safe = assertValidImportToken(token);
  const root = resolveImportSessionsRoot();
  return assertPathInside(root, path.join(root, safe));
}

function cleanupExpiredImportSessions(nowMs = Date.now()): void {
  const root = resolveImportSessionsRoot();
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!IMPORT_TOKEN_PATTERN.test(name)) continue;
    const dir = path.join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const expired = isSessionDirExpired(dir, nowMs);
      if (expired) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — never fail the request path.
    }
  }
}

function isSessionDirExpired(dir: string, nowMs: number): boolean {
  const sessionPath = path.join(dir, 'session.json');
  if (existsSync(sessionPath)) {
    try {
      const record = JSON.parse(readFileSync(sessionPath, 'utf8')) as ImportSessionRecord;
      const expires = Date.parse(record.expiresAt);
      if (Number.isFinite(expires)) return expires <= nowMs;
    } catch {
      // fall through
    }
  }
  const stagedPath = path.join(dir, 'staged.json');
  if (existsSync(stagedPath)) {
    try {
      const staged = JSON.parse(readFileSync(stagedPath, 'utf8')) as StagedMeta;
      if (typeof staged.createdAtUnix === 'number') {
        return staged.createdAtUnix * 1000 + IMPORT_SESSION_TTL_MS <= nowMs;
      }
    } catch {
      // fall through
    }
  }
  try {
    const mtime = statSync(dir).mtimeMs;
    return mtime + IMPORT_SESSION_TTL_MS <= nowMs;
  } catch {
    return false;
  }
}

export function readStagedMeta(token: string): { meta: StagedMeta; sourcePath: string; bytes: Buffer } {
  cleanupExpiredImportSessions();
  const dir = sessionDirForToken(token);
  if (!existsSync(dir)) {
    throw new Error('Import session not found or expired.');
  }
  const stagedPath = assertPathInside(dir, path.join(dir, 'staged.json'));
  if (!existsSync(stagedPath)) {
    throw new Error('Import session is missing staged metadata.');
  }
  let meta: StagedMeta;
  try {
    meta = JSON.parse(readFileSync(stagedPath, 'utf8')) as StagedMeta;
  } catch {
    throw new Error('Import session staged metadata is corrupt.');
  }
  if (
    typeof meta.basename !== 'string'
    || typeof meta.stagedName !== 'string'
    || !meta.stagedName
    || meta.stagedName.includes('..')
    || meta.stagedName.includes('/')
    || meta.stagedName.includes('\\')
  ) {
    throw new Error('Import session staged metadata is invalid.');
  }
  const sourcePath = assertPathInside(dir, path.join(dir, meta.stagedName));
  if (!existsSync(sourcePath)) {
    throw new Error('Staged manuscript file is missing.');
  }
  const st = statSync(sourcePath);
  if (!st.isFile()) throw new Error('Staged manuscript path is not a file.');
  if (st.size <= 0) throw new Error('The selected file is empty.');
  if (st.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error('The selected file is too large to import (max 25 MB).');
  }
  const bytes = readFileSync(sourcePath);
  if (bytes.length > MAX_IMPORT_FILE_BYTES) {
    throw new Error('The selected file is too large to import (max 25 MB).');
  }
  return { meta, sourcePath, bytes };
}

export function writeImportSession(record: ImportSessionRecord): void {
  const dir = sessionDirForToken(record.token);
  mkdirSync(dir, { recursive: true });
  const sessionPath = assertPathInside(dir, path.join(dir, 'session.json'));
  writeFileSync(sessionPath, JSON.stringify(record), 'utf8');
}

export function loadImportSession(token: string): ImportSessionRecord {
  cleanupExpiredImportSessions();
  const dir = sessionDirForToken(token);
  const sessionPath = assertPathInside(dir, path.join(dir, 'session.json'));
  if (!existsSync(sessionPath)) {
    throw new Error('Import session not found or expired.');
  }
  let record: ImportSessionRecord;
  try {
    record = JSON.parse(readFileSync(sessionPath, 'utf8')) as ImportSessionRecord;
  } catch {
    throw new Error('Import session is corrupt.');
  }
  if (!record || typeof record !== 'object') {
    throw new Error('Import session is invalid.');
  }
  if (record.version !== 1 || record.token !== assertValidImportToken(token)) {
    throw new Error('Import session is invalid.');
  }
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('Import session not found or expired.');
  }
  if (record.ownerUserId !== LOCAL_USER_ID) {
    throw new Error('Import session is not owned by this desktop user.');
  }
  if (record.desktopSessionBinding !== desktopSessionBinding()) {
    throw new Error('Import session is not bound to this desktop session.');
  }
  assertValidStoredSessionPayload(record);
  return record;
}

function assertValidStoredSessionPayload(record: ImportSessionRecord): void {
  if (
    (record.source !== 'txt' && record.source !== 'md' && record.source !== 'docx')
    || typeof record.basename !== 'string'
    || typeof record.filename !== 'string'
    || typeof record.suggestedTitle !== 'string'
    || CONTROL_CHAR_RE.test(record.basename)
    || record.basename !== record.filename
    || !Array.isArray(record.segments)
    || record.segments.length === 0
    || record.segments.length > MAX_IMPORT_CHAPTERS
  ) {
    throw new Error('Import session payload is invalid.');
  }

  const segmentIds = new Set<string>();
  let paragraphCount = 0;
  let reconstructedBytes = 0;
  for (const segment of record.segments) {
    if (
      !segment
      || typeof segment.id !== 'string'
      || !segment.id
      || segmentIds.has(segment.id)
      || typeof segment.title !== 'string'
      || segment.title.length > MAX_IMPORT_TITLE_CHARS
      || CONTROL_CHAR_RE.test(segment.title)
      || (segment.volumeTitle !== null && typeof segment.volumeTitle !== 'string')
      || (
        typeof segment.volumeTitle === 'string'
        && (
          segment.volumeTitle.length > MAX_IMPORT_TITLE_CHARS
          || CONTROL_CHAR_RE.test(segment.volumeTitle)
        )
      )
      || !Array.isArray(segment.paragraphs)
      || typeof segment.wordCount !== 'number'
      || !Number.isFinite(segment.wordCount)
      || segment.wordCount < 0
      || typeof segment.inferred !== 'boolean'
    ) {
      throw new Error('Import session segment is invalid.');
    }
    segmentIds.add(segment.id);
    paragraphCount += segment.paragraphs.length;
    reconstructedBytes += Buffer.byteLength(segment.title, 'utf8');
    for (const paragraph of segment.paragraphs) {
      if (typeof paragraph !== 'string') {
        throw new Error('Import session paragraph is invalid.');
      }
      reconstructedBytes += Buffer.byteLength(paragraph, 'utf8');
    }
  }
  if (
    paragraphCount > MAX_IMPORT_PARAGRAPHS
    || reconstructedBytes > MAX_IMPORT_RECONSTRUCTED_BYTES
  ) {
    throw new Error('Import session payload exceeds the safe complexity limit.');
  }
}

export function removeImportSession(token: string): void {
  try {
    const dir = sessionDirForToken(token);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — confirm already succeeded.
  }
}

/** Test helper: write a Rust-compatible staged payload without the native picker. */
export function stageTestManuscript(args: {
  token: string;
  basename: string;
  bytes: Buffer;
}): string {
  const token = assertValidImportToken(args.token);
  const ext = path.extname(args.basename).replace(/^\./, '').toLowerCase() || 'txt';
  const dir = sessionDirForToken(token);
  mkdirSync(dir, { recursive: true });
  const stagedName = `source.${ext}`;
  const sourcePath = assertPathInside(dir, path.join(dir, stagedName));
  writeFileSync(sourcePath, args.bytes);
  writeFileSync(
    assertPathInside(dir, path.join(dir, 'staged.json')),
    JSON.stringify({
      basename: args.basename,
      stagedName,
      createdAtUnix: Math.floor(Date.now() / 1000),
    }),
  );
  return dir;
}
