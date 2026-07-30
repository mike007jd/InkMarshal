// Project-backup (W1-3) — read + verify a `.inkmarshal` package.
//
// Two integrity layers:
//   1. Per-file SHA-256 vs the manifest map (detects any byte tamper / truncation).
//   2. Referential integrity (relation endpoints exist in entries; every outline
//      chapterNumber has a matching chapter file; conversation/message refs).
//
// Compatibility gate: current 2.0 plus the explicitly published 1.0 / 1.1
// formats. Unknown legacy minors, future 2.x minors, and malformed versions are
// rejected — this build cannot restore layouts it does not understand.
// `dbSchemaVersion` is informational only (shown in the preview, never blocks).
//
// ZIP resource guard: central/local metadata is only an early-rejection hint.
// Every DEFLATE stream is inflated with a hard output ceiling, then its actual
// length and CRC are checked before any package content is trusted.

import { crc32, inflateRawSync } from 'node:zlib';
import { strFromU8 } from 'fflate';
import { sha256Hex } from '@/lib/backup/build-package';
import {
  PACKAGE_PATHS,
  HISTORY_PACKAGE_PATHS,
  FORMAT_VERSION,
  isSecretKey,
  type InkmarshalManifest,
  type BackupBundle,
  type BackupNovel,
  type BackupChapter,
  type BackupKnowledgeEntry,
  type BackupKnowledgeRelation,
  type BackupOutlineRow,
  type BackupPromptTemplate,
  type BackupAttachment,
  type BackupConversation,
  type BackupMessage,
  type BackupChapterChat,
  type BackupVolumeSummary,
} from '@/lib/backup/types';
import type { UnificationReport } from '@/lib/db-types';

/** Hard limits for the pre-decompression ZIP resource guard. */
export const ZIP_MAX_ENTRIES = 4096;
export const ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024; // 64 MiB
export const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MiB

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP64_VERSION = 45;
const ZIP_END_BYTES = 22;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_REJECTED_FLAGS = 0x0001 | 0x0040;

export interface VerifyIssue {
  /** Machine code so the UI can localize; `detail` is a fallback English string. */
  code:
    | 'not_a_zip'
    | 'missing_manifest'
    | 'bad_manifest'
    | 'format_incompatible'
    | 'unsupported_attachments'
    | 'missing_file'
    | 'missing_checksum'
    | 'sha256_mismatch'
    | 'unexpected_secret'
    | 'dangling_relation'
    | 'dangling_message_conversation'
    | 'dangling_conversation_parent'
    | 'duplicate_identity'
    | 'conflicting_outline_projection'
    | 'orphan_outline'
    | 'count_mismatch'
    | 'corrupt_section'
    | 'zip_too_many_entries'
    | 'zip_entry_too_large'
    | 'zip_total_too_large'
    | 'zip_duplicate_name'
    | 'zip_unsafe_path';
  detail: string;
  /** Optional file path / id the issue is about. */
  ref?: string;
}

export interface VerifyReport {
  /** True only when there are zero blocking issues (restore is safe). */
  ok: boolean;
  /** Manifest, when it parsed (null when the package isn't even a valid zip). */
  manifest: InkmarshalManifest | null;
  /** Blocking problems — any one of these means restore must be refused. */
  errors: VerifyIssue[];
  /** Non-blocking observations (informational). */
  warnings: VerifyIssue[];
  /** Format major-version compatibility (false => rejected). */
  formatCompatible: boolean;
  /** Parsed bundle, present only when `ok` is true (handed to restore). */
  bundle: BackupBundle | null;
}

class ZipArchiveError extends Error {
  readonly issue: VerifyIssue | null;

  constructor(issue: VerifyIssue | null = null) {
    super(issue?.detail ?? 'Invalid ZIP archive');
    this.name = 'ZipArchiveError';
    this.issue = issue;
  }
}

interface ZipEntryRange {
  start: number;
  end: number;
}

interface ZipPayload {
  name: string;
  method: number;
  start: number;
  end: number;
  declaredUncompressedSize: number;
  crc: number;
}

function invalidZip(): never {
  throw new ZipArchiveError();
}

function rejectZip(issue: VerifyIssue): never {
  throw new ZipArchiveError(issue);
}

function hasZip64ExtraField(extra: Buffer): boolean {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) invalidZip();
    const fieldId = extra.readUInt16LE(offset);
    const fieldLength = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + fieldLength > extra.length) invalidZip();
    if (fieldId === ZIP64_EXTRA_FIELD_ID) return true;
    offset += fieldLength;
  }
  return false;
}

function decodeZipEntryName(nameBytes: Buffer): string {
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
  } catch {
    invalidZip();
  }
  if (isUnsafeZipEntryName(name)) {
    rejectZip({
      code: 'zip_unsafe_path',
      detail: `Archive entry name is unsafe: ${name}`,
      ref: name,
    });
  }
  return name;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < ZIP_END_BYTES) invalidZip();
  const earliest = Math.max(0, buffer.length - ZIP_END_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = buffer.length - ZIP_END_BYTES; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + ZIP_END_BYTES + commentLength === buffer.length) return offset;
  }
  return invalidZip();
}

function dataDescriptorEnd(
  buffer: Buffer,
  start: number,
  upperBound: number,
  expectedCrc: number,
  expectedCompressedSize: number,
  expectedUncompressedSize: number,
): number {
  const matchesAt = (offset: number): boolean =>
    offset + 12 <= upperBound
    && buffer.readUInt32LE(offset) === expectedCrc
    && buffer.readUInt32LE(offset + 4) === expectedCompressedSize
    && buffer.readUInt32LE(offset + 8) === expectedUncompressedSize;

  if (
    start + 16 <= upperBound
    && buffer.readUInt32LE(start) === ZIP_DATA_DESCRIPTOR_SIGNATURE
    && matchesAt(start + 4)
  ) {
    return start + 16;
  }
  if (matchesAt(start)) return start + 12;
  return invalidZip();
}

function parseFormatVersion(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)$/.exec(String(version));
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return { major, minor };
}

/**
 * Accept only formats whose semantics this build explicitly understands.
 * 1.0 / 1.1 are published legacy contracts; 2.0 is current. Do not use a broad
 * "older major is safe" rule: a lower major can still be an unknown layout.
 */
export function isFormatCompatible(formatVersion: string): boolean {
  const candidate = parseFormatVersion(formatVersion);
  if (!candidate) return false;
  if (candidate.major === 1) return candidate.minor === 0 || candidate.minor === 1;
  return candidate.major === 2 && candidate.minor === 0;
}

/** Format 1.1+ requires the fixed history files to be present and checksummed. */
function requiresHistoryLayout(formatVersion: string): boolean {
  const candidate = parseFormatVersion(formatVersion);
  return candidate !== null
    && (candidate.major >= 2 || (candidate.major === 1 && candidate.minor >= 1));
}

/** Format 2.0+ requires an explicit lifecycle state in every chapter file. */
function requiresChapterProcessingStatus(formatVersion: string): boolean {
  const candidate = parseFormatVersion(formatVersion);
  return candidate !== null && candidate.major >= 2;
}

function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isBackupVolumeSummary(value: unknown): value is BackupVolumeSummary {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.start)
    && isFiniteNumber(value.end)
    && typeof value.summary === 'string';
}

type BackupNovelPayload = Omit<BackupNovel, 'volumeSummaries'> & {
  volumeSummaries?: unknown;
};

function isBackupNovelPayload(value: unknown): value is BackupNovelPayload {
  if (!isRecord(value)) return false;
  return typeof value.title === 'string'
    && typeof value.genre === 'string'
    && isFiniteNumber(value.targetWords)
    && typeof value.stage === 'string'
    && isFiniteNumber(value.progress)
    && typeof value.storySummary === 'string'
    && typeof value.characterSummary === 'string'
    && typeof value.arcSummary === 'string'
    && (value.interviewState === null || isRecord(value.interviewState))
    && (value.settings === null || isRecord(value.settings))
    && isFiniteNumber(value.createdAt)
    && isFiniteNumber(value.updatedAt);
}

type SerializedBackupChapter = Omit<BackupChapter, 'processingStatus'> & {
  processingStatus?: 'content_saved' | 'complete';
};

function isSerializedBackupChapter(value: unknown): value is SerializedBackupChapter {
  if (!isRecord(value)) return false;
  const statusOk = value.processingStatus === undefined
    || value.processingStatus === 'content_saved'
    || value.processingStatus === 'complete';
  return isFiniteNumber(value.chapterNumber)
    && typeof value.title === 'string'
    && typeof value.content === 'string'
    && isNullableString(value.originalContent)
    && isFiniteNumber(value.wordCount)
    && isFiniteNumber(value.version)
    && typeof value.summary === 'string'
    && (value.keyFacts === null || isRecord(value.keyFacts))
    && (value.qualityIssues === null || Array.isArray(value.qualityIssues))
    && (value.generationMeta === null || isRecord(value.generationMeta))
    && (value.snapshots === null || Array.isArray(value.snapshots))
    && statusOk
    && isFiniteNumber(value.createdAt);
}

function isBackupKnowledgeEntry(value: unknown): value is BackupKnowledgeEntry {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.type === 'string'
    && typeof value.title === 'string'
    && typeof value.summary === 'string'
    && typeof value.data === 'string'
    && isFiniteNumber(value.sortOrder)
    && typeof value.tags === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isBackupKnowledgeRelation(value: unknown): value is BackupKnowledgeRelation {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.sourceId === 'string'
    && typeof value.targetId === 'string'
    && typeof value.relationType === 'string'
    && typeof value.label === 'string'
    && typeof value.createdAt === 'string';
}

function isBackupOutlineRow(value: unknown): value is BackupOutlineRow {
  if (!isRecord(value)) return false;
  return typeof value.entryId === 'string'
    && isFiniteNumber(value.chapterNumber)
    && typeof value.chapterId === 'string'
    && isFiniteNumber(value.sortOrder);
}

function isBackupPromptTemplate(value: unknown): value is BackupPromptTemplate {
  if (!isRecord(value)) return false;
  return typeof value.stage === 'string'
    && (value.role === 'user' || value.role === 'system')
    && typeof value.locale === 'string'
    && typeof value.variant === 'string'
    && isFiniteNumber(value.version)
    && typeof value.templateText === 'string'
    && typeof value.variablesSchema === 'string';
}

function isBackupConversation(value: unknown): value is BackupConversation {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.topic === 'string'
    && typeof value.title === 'string'
    && isNullableString(value.parentMessageId)
    && typeof value.isArchived === 'boolean'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isBackupMessage(value: unknown): value is BackupMessage {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && isNullableString(value.conversationId)
    && (value.role === 'user' || value.role === 'assistant' || value.role === 'system')
    && typeof value.content === 'string'
    && typeof value.createdAt === 'string';
}

function isBackupChapterChat(value: unknown): value is BackupChapterChat {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && isFiniteNumber(value.chapterNumber)
    && typeof value.role === 'string'
    && typeof value.content === 'string'
    && isNullableString(value.changes)
    && typeof value.status === 'string'
    && typeof value.createdAt === 'string';
}

/** Reject absolute paths, backslashes, NUL, and `.` / `..` path segments. */
export function isUnsafeZipEntryName(name: string): boolean {
  if (!name) return true;
  if (name.includes('\0')) return true;
  if (name.includes('\\')) return true;
  if (name.startsWith('/')) return true;
  // Drive-absolute forms (caught even without backslashes, e.g. "C:/foo").
  if (/^[A-Za-z]:\//.test(name)) return true;
  const segments = name.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..') return true;
  }
  return false;
}

/**
 * Parse and extract a non-ZIP64 archive without trusting its size metadata.
 * Central and local headers must agree, every payload range must be disjoint,
 * and DEFLATE output is stopped at the smaller remaining entry/total budget.
 */
function unzipWithResourceGuard(bytes: Uint8Array): {
  entries: Record<string, Uint8Array> | null;
  issue: VerifyIssue | null;
  zipError: boolean;
} {
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const endOffset = findEndOfCentralDirectory(buffer);
    const diskNumber = buffer.readUInt16LE(endOffset + 4);
    const centralDisk = buffer.readUInt16LE(endOffset + 6);
    const diskEntries = buffer.readUInt16LE(endOffset + 8);
    const totalEntries = buffer.readUInt16LE(endOffset + 10);
    const centralSize = buffer.readUInt32LE(endOffset + 12);
    const centralOffset = buffer.readUInt32LE(endOffset + 16);

    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      invalidZip();
    }
    if (
      totalEntries === 0xffff
      || centralSize === 0xffffffff
      || centralOffset === 0xffffffff
      || (
        endOffset >= 20
        && buffer.readUInt32LE(endOffset - 20) === ZIP64_LOCATOR_SIGNATURE
      )
    ) {
      invalidZip();
    }
    if (totalEntries > ZIP_MAX_ENTRIES) {
      rejectZip({
        code: 'zip_too_many_entries',
        detail: `Archive has more than ${ZIP_MAX_ENTRIES} entries.`,
        ref: String(totalEntries),
      });
    }

    const centralEnd = centralOffset + centralSize;
    if (
      !Number.isSafeInteger(centralEnd)
      || centralOffset > endOffset
      || centralEnd !== endOffset
    ) {
      invalidZip();
    }

    let cursor = centralOffset;
    let declaredTotal = 0;
    const seenNames = new Set<string>();
    const localRanges: ZipEntryRange[] = [];
    const payloads: ZipPayload[] = [];

    for (let index = 0; index < totalEntries; index += 1) {
      if (
        cursor + ZIP_CENTRAL_HEADER_BYTES > centralEnd
        || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE
      ) {
        invalidZip();
      }

      const versionNeeded = buffer.readUInt16LE(cursor + 6);
      const flags = buffer.readUInt16LE(cursor + 8);
      const method = buffer.readUInt16LE(cursor + 10);
      const crc = buffer.readUInt32LE(cursor + 16);
      const compressedSize = buffer.readUInt32LE(cursor + 20);
      const uncompressedSize = buffer.readUInt32LE(cursor + 24);
      const nameLength = buffer.readUInt16LE(cursor + 28);
      const extraLength = buffer.readUInt16LE(cursor + 30);
      const commentLength = buffer.readUInt16LE(cursor + 32);
      const diskStart = buffer.readUInt16LE(cursor + 34);
      const localOffset = buffer.readUInt32LE(cursor + 42);
      const centralEntryEnd =
        cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;

      if (centralEntryEnd > centralEnd || nameLength === 0) invalidZip();
      if (
        versionNeeded >= ZIP64_VERSION
        || compressedSize === 0xffffffff
        || uncompressedSize === 0xffffffff
        || localOffset === 0xffffffff
        || diskStart === 0xffff
      ) {
        invalidZip();
      }
      if (diskStart !== 0 || (flags & ZIP_REJECTED_FLAGS) !== 0) invalidZip();
      if (method !== 0 && method !== 8) invalidZip();

      const nameStart = cursor + ZIP_CENTRAL_HEADER_BYTES;
      const nameBytes = buffer.subarray(nameStart, nameStart + nameLength);
      const name = decodeZipEntryName(nameBytes);
      if (seenNames.has(name)) {
        rejectZip({
          code: 'zip_duplicate_name',
          detail: `Archive contains duplicate entry name: ${name}`,
          ref: name,
        });
      }
      seenNames.add(name);

      const centralExtraStart = nameStart + nameLength;
      const centralExtra = buffer.subarray(
        centralExtraStart,
        centralExtraStart + extraLength,
      );
      if (hasZip64ExtraField(centralExtra)) invalidZip();

      if (uncompressedSize > ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES) {
        rejectZip({
          code: 'zip_entry_too_large',
          detail: `Archive entry exceeds ${ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES} uncompressed bytes.`,
          ref: name,
        });
      }
      declaredTotal += uncompressedSize;
      if (declaredTotal > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
        rejectZip({
          code: 'zip_total_too_large',
          detail: `Archive total uncompressed size exceeds ${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes.`,
          ref: name,
        });
      }
      if (method === 0 && compressedSize !== uncompressedSize) invalidZip();

      if (
        localOffset + ZIP_LOCAL_HEADER_BYTES > centralOffset
        || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE
      ) {
        invalidZip();
      }
      const localFlags = buffer.readUInt16LE(localOffset + 6);
      const localMethod = buffer.readUInt16LE(localOffset + 8);
      const localCrc = buffer.readUInt32LE(localOffset + 14);
      const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
      const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const localNameStart = localOffset + ZIP_LOCAL_HEADER_BYTES;
      const localExtraStart = localNameStart + localNameLength;
      const dataStart = localExtraStart + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      const usesDataDescriptor = (flags & ZIP_DATA_DESCRIPTOR_FLAG) !== 0;

      if (
        localFlags !== flags
        || localMethod !== method
        || localNameLength !== nameLength
        || dataEnd > centralOffset
        || !buffer.subarray(localNameStart, localExtraStart).equals(nameBytes)
      ) {
        invalidZip();
      }
      const localExtra = buffer.subarray(localExtraStart, dataStart);
      if (hasZip64ExtraField(localExtra)) invalidZip();

      let localEntryEnd = dataEnd;
      if (usesDataDescriptor) {
        if (
          (localCrc !== 0 && localCrc !== crc)
          || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
          || (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)
        ) {
          invalidZip();
        }
        localEntryEnd = dataDescriptorEnd(
          buffer,
          dataEnd,
          centralOffset,
          crc,
          compressedSize,
          uncompressedSize,
        );
      } else if (
        localCrc !== crc
        || localCompressedSize !== compressedSize
        || localUncompressedSize !== uncompressedSize
      ) {
        invalidZip();
      }

      localRanges.push({ start: localOffset, end: localEntryEnd });
      payloads.push({
        name,
        method,
        start: dataStart,
        end: dataEnd,
        declaredUncompressedSize: uncompressedSize,
        crc,
      });
      cursor = centralEntryEnd;
    }

    if (cursor !== centralEnd) invalidZip();
    localRanges.sort((left, right) => left.start - right.start);
    for (let index = 1; index < localRanges.length; index += 1) {
      if (localRanges[index].start < localRanges[index - 1].end) invalidZip();
    }

    const entries = Object.create(null) as Record<string, Uint8Array>;
    let actualTotal = 0;
    for (const payload of payloads) {
      const compressed = buffer.subarray(payload.start, payload.end);
      const remainingTotal = ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES - actualTotal;
      const outputLimit = Math.min(
        ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES,
        remainingTotal,
      );
      let uncompressed: Buffer;
      if (payload.method === 0) {
        uncompressed = compressed;
      } else {
        try {
          uncompressed = inflateRawSync(compressed, {
            // The extra byte distinguishes an exact-limit payload from one that
            // must be rejected without allowing unbounded inflate work.
            maxOutputLength: outputLimit + 1,
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
            if (remainingTotal < ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES) {
              rejectZip({
                code: 'zip_total_too_large',
                detail: `Archive total uncompressed size exceeds ${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes.`,
                ref: payload.name,
              });
            }
            rejectZip({
              code: 'zip_entry_too_large',
              detail: `Archive entry exceeds ${ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES} uncompressed bytes.`,
              ref: payload.name,
            });
          }
          invalidZip();
        }
      }

      if (uncompressed.byteLength > ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES) {
        rejectZip({
          code: 'zip_entry_too_large',
          detail: `Archive entry exceeds ${ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES} uncompressed bytes.`,
          ref: payload.name,
        });
      }
      if (actualTotal + uncompressed.byteLength > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
        rejectZip({
          code: 'zip_total_too_large',
          detail: `Archive total uncompressed size exceeds ${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes.`,
          ref: payload.name,
        });
      }
      if (
        uncompressed.byteLength !== payload.declaredUncompressedSize
        || crc32(uncompressed) !== payload.crc
      ) {
        invalidZip();
      }

      actualTotal += uncompressed.byteLength;
      // Do not leak Node Buffer's view-only `.slice()` semantics to downstream
      // SHA code, which expects a standard Uint8Array whose `.slice()` copies
      // exactly this entry window.
      entries[payload.name] = new Uint8Array(
        uncompressed.buffer,
        uncompressed.byteOffset,
        uncompressed.byteLength,
      );
    }
    return { entries, issue: null, zipError: false };
  } catch (error) {
    if (error instanceof ZipArchiveError && error.issue) {
      return { entries: null, issue: error.issue, zipError: false };
    }
    return { entries: null, issue: null, zipError: true };
  }
}

/**
 * Verify a package's bytes. Never throws on a malformed package — every failure
 * becomes a {@link VerifyIssue} so the UI can render a precise preview. Only an
 * internal invariant violation would throw.
 */
export async function verifyBackupPackage(bytes: Uint8Array): Promise<VerifyReport> {
  const errors: VerifyIssue[] = [];
  const warnings: VerifyIssue[] = [];

  const unzipped = unzipWithResourceGuard(bytes);
  if (unzipped.zipError) {
    return {
      ok: false,
      manifest: null,
      errors: [{ code: 'not_a_zip', detail: 'File is not a valid .inkmarshal archive.' }],
      warnings,
      formatCompatible: false,
      bundle: null,
    };
  }
  if (unzipped.issue || !unzipped.entries) {
    return {
      ok: false,
      manifest: null,
      errors: [unzipped.issue ?? { code: 'not_a_zip', detail: 'File is not a valid .inkmarshal archive.' }],
      warnings,
      formatCompatible: false,
      bundle: null,
    };
  }
  const entries = unzipped.entries;

  const manifestRaw = entries[PACKAGE_PATHS.manifest];
  if (!manifestRaw) {
    return {
      ok: false,
      manifest: null,
      errors: [{ code: 'missing_manifest', detail: 'Package is missing manifest.json.' }],
      warnings,
      formatCompatible: false,
      bundle: null,
    };
  }
  const manifest = parseJson<InkmarshalManifest>(strFromU8(manifestRaw));
  if (!manifest || typeof manifest.formatVersion !== 'string' || !manifest.sha256) {
    return {
      ok: false,
      manifest: null,
      errors: [{ code: 'bad_manifest', detail: 'manifest.json is corrupt or incomplete.' }],
      warnings,
      formatCompatible: false,
      bundle: null,
    };
  }

  const formatCompatible = isFormatCompatible(manifest.formatVersion);
  if (!formatCompatible) {
    errors.push({
      code: 'format_incompatible',
      detail: `Package format v${manifest.formatVersion} is incompatible with this build (v${FORMAT_VERSION}).`,
      ref: manifest.formatVersion,
    });
  }

  // 1.1+ packages must list checksums for every fixed history file.
  if (formatCompatible && requiresHistoryLayout(manifest.formatVersion)) {
    for (const path of HISTORY_PACKAGE_PATHS) {
      if (!Object.hasOwn(manifest.sha256, path)) {
        errors.push({
          code: 'missing_checksum',
          detail: `Format ${manifest.formatVersion} requires a checksum for ${path}.`,
          ref: path,
        });
      }
    }
  }

  // --- Layer 1: per-file SHA-256 ---
  for (const path of Object.keys(entries)) {
    if (path !== PACKAGE_PATHS.manifest && !Object.hasOwn(manifest.sha256, path)) {
      errors.push({
        code: 'missing_checksum',
        detail: `Package contains ${path} but the manifest has no checksum for it.`,
        ref: path,
      });
    }
  }
  for (const [path, expected] of Object.entries(manifest.sha256)) {
    const fileBytes = entries[path];
    if (!fileBytes) {
      errors.push({ code: 'missing_file', detail: `Manifest lists ${path} but it is absent.`, ref: path });
      continue;
    }
    const actual = await sha256Hex(fileBytes);
    if (actual !== expected) {
      errors.push({ code: 'sha256_mismatch', detail: `Checksum mismatch for ${path}.`, ref: path });
    }
  }

  // If the format is incompatible or any checksum failed, stop before parsing —
  // a tampered file must never be interpreted as trusted content.
  if (!formatCompatible || errors.some(e =>
    e.code === 'sha256_mismatch'
    || e.code === 'missing_file'
    || e.code === 'missing_checksum')) {
    return { ok: false, manifest, errors, warnings, formatCompatible, bundle: null };
  }

  // --- Parse sections (post-integrity, so bytes are trusted) ---
  const novelRaw = parseJson<unknown>(
    strFromU8(entries[PACKAGE_PATHS.novel] ?? new Uint8Array()),
  );
  if (!isBackupNovelPayload(novelRaw)) {
    errors.push({ code: 'corrupt_section', detail: 'novel.json is corrupt.', ref: PACKAGE_PATHS.novel });
  }
  let novel: BackupNovel | undefined;
  if (isBackupNovelPayload(novelRaw)) {
    const hasVolumeSummaries = Object.hasOwn(novelRaw, 'volumeSummaries');
    const volumeSummaries = novelRaw.volumeSummaries;
    if (!hasVolumeSummaries && !requiresHistoryLayout(manifest.formatVersion)) {
      // 1.0 legitimately omitted this 1.1 field.
      novel = { ...novelRaw, volumeSummaries: [] };
    } else if (
      !Array.isArray(volumeSummaries)
      || !volumeSummaries.every(isBackupVolumeSummary)
    ) {
      errors.push({
        code: 'corrupt_section',
        detail: 'novel.json volumeSummaries is missing or corrupt.',
        ref: PACKAGE_PATHS.novel,
      });
    } else {
      novel = { ...novelRaw, volumeSummaries };
    }
  }

  const knowledgeEntries = parseArraySection(
    entries,
    PACKAGE_PATHS.knowledgeEntries,
    errors,
    isBackupKnowledgeEntry,
    true,
  );
  const knowledgeRelations = parseArraySection(
    entries,
    PACKAGE_PATHS.knowledgeRelations,
    errors,
    isBackupKnowledgeRelation,
    true,
  );
  const outline = parseArraySection(
    entries,
    PACKAGE_PATHS.outline,
    errors,
    isBackupOutlineRow,
    true,
  );
  const promptTemplates = parseArraySection(
    entries,
    PACKAGE_PATHS.promptTemplates,
    errors,
    isBackupPromptTemplate,
    true,
  );
  const unificationParsed = parseJson<unknown>(
    strFromU8(entries[PACKAGE_PATHS.unification] ?? new Uint8Array()),
  );
  const unificationReport =
    unificationParsed === null || isRecord(unificationParsed)
      ? unificationParsed as UnificationReport | null
      : null;
  if (unificationParsed === undefined || (unificationParsed !== null && !isRecord(unificationParsed))) {
    errors.push({
      code: 'corrupt_section',
      detail: `${PACKAGE_PATHS.unification} is corrupt.`,
      ref: PACKAGE_PATHS.unification,
    });
  }

  // History sections: absent in 1.0 → empty (no corrupt_section / count warning).
  // Present but corrupt → corrupt_section. 1.1 packages already required them above.
  const conversations = parseArraySection(
    entries,
    PACKAGE_PATHS.historyConversations,
    errors,
    isBackupConversation,
    false,
  );
  const messages = parseArraySection(
    entries,
    PACKAGE_PATHS.historyMessages,
    errors,
    isBackupMessage,
    false,
  );
  const chapterChat = parseArraySection(
    entries,
    PACKAGE_PATHS.historyChapterChat,
    errors,
    isBackupChapterChat,
    false,
  );

  // Chapters: read every chapters/NNNN.json the zip carries.
  const chapters: BackupChapter[] = [];
  const processingStatusRequired = requiresChapterProcessingStatus(manifest.formatVersion);
  for (const path of Object.keys(entries)) {
    if (!path.startsWith(PACKAGE_PATHS.chaptersDir) || !path.endsWith('.json')) continue;
    const ch = parseJson<unknown>(strFromU8(entries[path]));
    if (
      !isSerializedBackupChapter(ch)
      || (processingStatusRequired && ch.processingStatus === undefined)
    ) {
      errors.push({ code: 'corrupt_section', detail: `Chapter file ${path} is corrupt.`, ref: path });
      continue;
    }
    chapters.push({
      ...ch,
      // Published 1.x packages pre-date this lifecycle contract. Treat every
      // legacy chapter as complete even if an unknown extra field is present;
      // only a 2.x version signal may carry content_saved semantics.
      processingStatus: processingStatusRequired ? ch.processingStatus! : 'complete',
    });
  }
  chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);

  // Attachments: layout reserved, but this build cannot restore them — reject
  // nonempty packages rather than verify OK and silently drop on restore.
  const attachments: BackupAttachment[] = [];
  for (const path of Object.keys(entries)) {
    if (!path.startsWith(PACKAGE_PATHS.attachmentsDir)) continue;
    const name = path.slice(PACKAGE_PATHS.attachmentsDir.length);
    if (!name) continue;
    attachments.push({ name, contentsBase64: Buffer.from(entries[path]).toString('base64') });
  }
  if (attachments.length > 0) {
    errors.push({
      code: 'unsupported_attachments',
      detail: `This build cannot restore package attachments (${attachments.length} file(s)). Re-export without attachments or use a build that supports them.`,
      ref: PACKAGE_PATHS.attachmentsDir,
    });
  }

  // --- Secret re-scan (defense in depth; should be a no-op if extract worked) ---
  if (novel?.settings) {
    if (settingsContainsSecret(novel.settings as Record<string, unknown>)) {
      errors.push({
        code: 'unexpected_secret',
        detail: 'novel.json settings still contain a secret-named key.',
        ref: PACKAGE_PATHS.novel,
      });
    }
  }

  // --- Layer 2: referential integrity ---
  reportDuplicateIdentities(
    chapters,
    chapter => String(chapter.chapterNumber),
    'chapter number',
    errors,
  );
  reportDuplicateIdentities(knowledgeEntries, entry => entry.id, 'knowledge entry id', errors);
  reportDuplicateIdentities(knowledgeRelations, relation => relation.id, 'knowledge relation id', errors);
  reportDuplicateIdentities(outline, row => row.entryId, 'outline entry id', errors);
  reportDuplicateIdentities(
    promptTemplates,
    template => JSON.stringify([
      template.stage,
      template.role,
      template.locale,
      template.variant,
    ]),
    'prompt template identity',
    errors,
  );
  reportDuplicateIdentities(conversations, conversation => conversation.id, 'conversation id', errors);
  reportDuplicateIdentities(messages, message => message.id, 'message id', errors);
  reportDuplicateIdentities(chapterChat, row => row.id, 'chapter chat id', errors);

  const entryIds = new Set(knowledgeEntries.map(e => e.id));
  const entriesById = new Map(knowledgeEntries.map(entry => [entry.id, entry]));
  for (const rel of knowledgeRelations) {
    if (!entryIds.has(rel.sourceId)) {
      errors.push({ code: 'dangling_relation', detail: `Relation ${rel.id} source ${rel.sourceId} is missing from entries.`, ref: rel.id });
    }
    if (!entryIds.has(rel.targetId)) {
      errors.push({ code: 'dangling_relation', detail: `Relation ${rel.id} target ${rel.targetId} is missing from entries.`, ref: rel.id });
    }
  }

  const conversationIds = new Set(conversations.map(c => c.id));
  const messageIds = new Set(messages.map(m => m.id));
  for (const msg of messages) {
    if (msg.conversationId != null && !conversationIds.has(msg.conversationId)) {
      errors.push({
        code: 'dangling_message_conversation',
        detail: `Message ${msg.id} references missing conversation ${msg.conversationId}.`,
        ref: msg.id,
      });
    }
  }
  for (const conv of conversations) {
    if (conv.parentMessageId != null && !messageIds.has(conv.parentMessageId)) {
      errors.push({
        code: 'dangling_conversation_parent',
        detail: `Conversation ${conv.id} references missing parent message ${conv.parentMessageId}.`,
        ref: conv.id,
      });
    }
  }

  const chapterNumbers = new Set(chapters.map(c => c.chapterNumber));
  const projectedOutlineEntryIds = new Set<string>();
  const chapterNumberByOldChapterId = new Map<string, number>();
  for (const entry of knowledgeEntries) {
    if (entry.type !== 'outline') continue;
    const data = parseJson<unknown>(entry.data);
    if (!isRecord(data)) continue;
    const parentId = data.parentId;
    if (Object.hasOwn(data, 'parentId') && typeof parentId !== 'string') {
      errors.push({
        code: 'conflicting_outline_projection',
        detail: `Outline entry ${entry.id} has an invalid parent id.`,
        ref: entry.id,
      });
      continue;
    }
    if (typeof parentId === 'string' && parentId) {
      const parent = entriesById.get(parentId);
      if (parent?.type !== 'outline') {
        errors.push({
          code: 'conflicting_outline_projection',
          detail: `Outline entry ${entry.id} references missing outline parent ${parentId}.`,
          ref: entry.id,
        });
      }
    }
  }
  for (const row of outline) {
    projectedOutlineEntryIds.add(row.entryId);
    const entry = entriesById.get(row.entryId);
    const data = entry ? parseJson<unknown>(entry.data) : undefined;
    const dataObject = isRecord(data) ? data : null;
    const projectedChapterNumber =
      dataObject && isFiniteNumber(dataObject.chapterNumber)
        ? dataObject.chapterNumber
        : entry
          ? entry.sortOrder + 1
          : null;
    const projectedChapterId =
      dataObject && typeof dataObject.chapterId === 'string'
        ? dataObject.chapterId
        : '';
    if (
      !entry
      || entry.type !== 'outline'
      || !dataObject
      || projectedChapterNumber !== row.chapterNumber
      || projectedChapterId !== row.chapterId
      || entry.sortOrder !== row.sortOrder
    ) {
      errors.push({
        code: 'conflicting_outline_projection',
        detail: `Outline row ${row.entryId} does not match its knowledge entry.`,
        ref: row.entryId,
      });
    }
    if (row.chapterId) {
      const priorChapterNumber = chapterNumberByOldChapterId.get(row.chapterId);
      if (
        priorChapterNumber !== undefined
        && priorChapterNumber !== row.chapterNumber
      ) {
        errors.push({
          code: 'conflicting_outline_projection',
          detail: `Outline chapter id ${row.chapterId} maps to both chapter ${priorChapterNumber} and chapter ${row.chapterNumber}.`,
          ref: row.chapterId,
        });
      } else {
        chapterNumberByOldChapterId.set(row.chapterId, row.chapterNumber);
      }
    }
    // An outline row may legitimately be unwritten (no chapter yet). Only flag a
    // row that claims a chapterNumber for which no chapter file exists AND whose
    // chapterId is set (i.e. it asserts a drafted chapter that's missing).
    if (row.chapterId && !chapterNumbers.has(row.chapterNumber)) {
      warnings.push({
        code: 'orphan_outline',
        detail: `Outline row ${row.entryId} links chapter ${row.chapterNumber} but no chapter file exists.`,
        ref: row.entryId,
      });
    }
  }
  for (const entry of knowledgeEntries) {
    if (entry.type === 'outline' && !projectedOutlineEntryIds.has(entry.id)) {
      errors.push({
        code: 'conflicting_outline_projection',
        detail: `Outline knowledge entry ${entry.id} is missing from outline.json.`,
        ref: entry.id,
      });
    }
  }

  // --- Count cross-check (manifest vs actual; mismatch is a warning) ---
  // Only warn when the manifest actually carries the count key — 1.0 packages
  // omit the new history counts and must not emit count_mismatch noise.
  const actualCounts = {
    chapters: chapters.length,
    knowledgeEntries: knowledgeEntries.length,
    knowledgeRelations: knowledgeRelations.length,
    outline: outline.length,
    promptTemplates: promptTemplates.length,
    attachments: attachments.length,
    conversations: conversations.length,
    messages: messages.length,
    chapterChat: chapterChat.length,
  };
  if (manifest.counts) {
    const declaredCounts = manifest.counts as unknown as Partial<Record<keyof typeof actualCounts, number>>;
    for (const [k, v] of Object.entries(actualCounts) as [keyof typeof actualCounts, number][]) {
      const expected = declaredCounts[k];
      if (typeof expected === 'number' && expected !== v) {
        warnings.push({
          code: 'count_mismatch',
          detail: `Manifest count for ${k} (${expected}) differs from actual (${v}).`,
          ref: k,
        });
      }
    }
  }

  const ok = errors.length === 0 && Boolean(novel);
  const bundle: BackupBundle | null = ok && novel
    ? {
        novel,
        chapters,
        knowledgeEntries,
        knowledgeRelations,
        outline,
        unificationReport,
        promptTemplates,
        conversations,
        messages,
        chapterChat,
        attachments,
        meta: {
          appVersion: manifest.appVersion,
          dbSchemaVersion: manifest.dbSchemaVersion,
          sourceNovelId: '',
          exportedAt: manifest.exportedAt,
        },
      }
    : null;

  return { ok, manifest, errors, warnings, formatCompatible, bundle };
}

function reportDuplicateIdentities<T>(
  items: readonly T[],
  identity: (item: T) => string,
  label: string,
  errors: VerifyIssue[],
): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const item of items) {
    const value = identity(item);
    if (seen.has(value) && !reported.has(value)) {
      errors.push({
        code: 'duplicate_identity',
        detail: `Package contains duplicate ${label}: ${value}.`,
        ref: value,
      });
      reported.add(value);
    }
    seen.add(value);
  }
}

/**
 * Parse and structurally validate a JSON-array section. Optional sections use
 * missing → [] for 1.0 forward compatibility; required fixed-layout sections
 * treat a missing file as corrupt even when a forged manifest also omitted it.
 */
function parseArraySection<T>(
  entries: Record<string, Uint8Array>,
  path: string,
  errors: VerifyIssue[],
  isItem: (value: unknown) => value is T,
  required: boolean,
): T[] {
  const raw = entries[path];
  if (!raw) {
    if (required) {
      errors.push({ code: 'corrupt_section', detail: `${path} is missing.`, ref: path });
    }
    return [];
  }
  const parsed = parseJson<unknown>(strFromU8(raw));
  if (!Array.isArray(parsed) || !parsed.every(isItem)) {
    errors.push({ code: 'corrupt_section', detail: `${path} is corrupt.`, ref: path });
    return [];
  }
  return parsed as T[];
}

/** Recursive secret-key presence check (mirrors extract's stripper). */
function settingsContainsSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(settingsContainsSecret);
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(k)) return true;
      if (settingsContainsSecret(v)) return true;
    }
  }
  return false;
}
