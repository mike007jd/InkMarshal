// Project-backup (W1-3) — read + verify a `.inkmarshal` package.
//
// Two integrity layers:
//   1. Per-file SHA-256 vs the manifest map (detects any byte tamper / truncation).
//   2. Referential integrity (relation endpoints exist in entries; every outline
//      chapterNumber has a matching chapter file; conversation/message refs).
//
// Compatibility gate: the MAJOR of `formatVersion` must equal the running
// build's; a MAJOR mismatch is a breaking layout change and is rejected outright.
// `dbSchemaVersion` is informational only (shown in the preview, never blocks).
//
// Pre-decompression ZIP resource guard (fflate `unzipSync` filter metadata):
// refuses oversized / unsafe archives before inflate allocates refused output.

import { strFromU8, unzipSync, type UnzipFileInfo } from 'fflate';
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

export interface VerifyIssue {
  /** Machine code so the UI can localize; `detail` is a fallback English string. */
  code:
    | 'not_a_zip'
    | 'missing_manifest'
    | 'bad_manifest'
    | 'format_incompatible'
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

function majorOf(version: string): string {
  return String(version).split('.')[0] ?? '';
}

function minorOf(version: string): number {
  const n = Number.parseInt(String(version).split('.')[1] ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

/** Format 1.1+ requires the fixed history files to be present and checksummed. */
function requiresHistoryLayout(formatVersion: string): boolean {
  return majorOf(formatVersion) === majorOf(FORMAT_VERSION) && minorOf(formatVersion) >= 1;
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

function isBackupChapter(value: unknown): value is BackupChapter {
  if (!isRecord(value)) return false;
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
 * Pre-decompression resource guard. Uses fflate's `unzipSync` filter, which
 * runs against central-directory metadata before inflate allocates output.
 * On violation the filter returns false (skips the refused entry) and records
 * a precise {@link VerifyIssue}; the caller must discard any partial output.
 */
function unzipWithResourceGuard(bytes: Uint8Array): {
  entries: Record<string, Uint8Array> | null;
  issue: VerifyIssue | null;
  zipError: boolean;
} {
  let issue: VerifyIssue | null = null;
  let entryCount = 0;
  let totalUncompressed = 0;
  const seenNames = new Set<string>();

  const refuse = (next: VerifyIssue): false => {
    if (!issue) issue = next;
    return false;
  };

  const filter = (file: UnzipFileInfo): boolean => {
    // Once refused, skip every remaining entry so nothing further is allocated.
    if (issue) return false;

    entryCount += 1;
    if (entryCount > ZIP_MAX_ENTRIES) {
      return refuse({
        code: 'zip_too_many_entries',
        detail: `Archive has more than ${ZIP_MAX_ENTRIES} entries.`,
        ref: String(entryCount),
      });
    }

    if (isUnsafeZipEntryName(file.name)) {
      return refuse({
        code: 'zip_unsafe_path',
        detail: `Archive entry name is unsafe: ${file.name}`,
        ref: file.name,
      });
    }

    if (seenNames.has(file.name)) {
      return refuse({
        code: 'zip_duplicate_name',
        detail: `Archive contains duplicate entry name: ${file.name}`,
        ref: file.name,
      });
    }
    seenNames.add(file.name);

    if (file.originalSize > ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES) {
      return refuse({
        code: 'zip_entry_too_large',
        detail: `Archive entry exceeds ${ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES} uncompressed bytes.`,
        ref: file.name,
      });
    }

    if (totalUncompressed + file.originalSize > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      return refuse({
        code: 'zip_total_too_large',
        detail: `Archive total uncompressed size exceeds ${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes.`,
        ref: file.name,
      });
    }
    totalUncompressed += file.originalSize;
    return true;
  };

  try {
    const entries = unzipSync(bytes, { filter });
    if (issue) return { entries: null, issue, zipError: false };
    return { entries, issue: null, zipError: false };
  } catch {
    // Some malformed archives can still make fflate throw after the filter has
    // already refused a resource or path violation. Preserve the more precise
    // refusal instead of degrading it to a generic "not a zip" result.
    return issue
      ? { entries: null, issue, zipError: false }
      : { entries: null, issue: null, zipError: true };
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

  const formatCompatible = majorOf(manifest.formatVersion) === majorOf(FORMAT_VERSION);
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
  for (const path of Object.keys(entries)) {
    if (!path.startsWith(PACKAGE_PATHS.chaptersDir) || !path.endsWith('.json')) continue;
    const ch = parseJson<unknown>(strFromU8(entries[path]));
    if (!isBackupChapter(ch)) {
      errors.push({ code: 'corrupt_section', detail: `Chapter file ${path} is corrupt.`, ref: path });
      continue;
    }
    chapters.push(ch);
  }
  chapters.sort((a, b) => a.chapterNumber - b.chapterNumber);

  // Attachments (optional, forward-compat).
  const attachments: BackupAttachment[] = [];
  for (const path of Object.keys(entries)) {
    if (!path.startsWith(PACKAGE_PATHS.attachmentsDir)) continue;
    const name = path.slice(PACKAGE_PATHS.attachmentsDir.length);
    if (!name) continue;
    attachments.push({ name, contentsBase64: Buffer.from(entries[path]).toString('base64') });
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
