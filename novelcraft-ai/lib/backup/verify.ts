// Project-backup (W1-3) — read + verify a `.inkmarshal` package.
//
// Two integrity layers:
//   1. Per-file SHA-256 vs the manifest map (detects any byte tamper / truncation).
//   2. Referential integrity (relation endpoints exist in entries; every outline
//      chapterNumber has a matching chapter file).
//
// Compatibility gate: the MAJOR of `formatVersion` must equal the running
// build's; a MAJOR mismatch is a breaking layout change and is rejected outright.
// `dbSchemaVersion` is informational only (shown in the preview, never blocks).

import { strFromU8, unzipSync } from 'fflate';
import { sha256Hex } from '@/lib/backup/build-package';
import {
  PACKAGE_PATHS,
  FORMAT_VERSION,
  chapterEntryPath,
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
} from '@/lib/backup/types';
import type { UnificationReport } from '@/lib/db-types';

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
    | 'orphan_outline'
    | 'count_mismatch'
    | 'corrupt_section';
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

function parseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
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

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return {
      ok: false,
      manifest: null,
      errors: [{ code: 'not_a_zip', detail: 'File is not a valid .inkmarshal archive.' }],
      warnings,
      formatCompatible: false,
      bundle: null,
    };
  }

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
    e.code === 'sha256_mismatch' || e.code === 'missing_file' || e.code === 'missing_checksum')) {
    return { ok: false, manifest, errors, warnings, formatCompatible, bundle: null };
  }

  // --- Parse sections (post-integrity, so bytes are trusted) ---
  const novel = parseJson<BackupNovel>(strFromU8(entries[PACKAGE_PATHS.novel] ?? new Uint8Array()));
  if (!novel) {
    errors.push({ code: 'corrupt_section', detail: 'novel.json is corrupt.', ref: PACKAGE_PATHS.novel });
  }

  const knowledgeEntries =
    parseJson<BackupKnowledgeEntry[]>(strFromU8(entries[PACKAGE_PATHS.knowledgeEntries] ?? strFromBytesEmptyArray())) ?? [];
  const knowledgeRelations =
    parseJson<BackupKnowledgeRelation[]>(strFromU8(entries[PACKAGE_PATHS.knowledgeRelations] ?? strFromBytesEmptyArray())) ?? [];
  const outline =
    parseJson<BackupOutlineRow[]>(strFromU8(entries[PACKAGE_PATHS.outline] ?? strFromBytesEmptyArray())) ?? [];
  const promptTemplates =
    parseJson<BackupPromptTemplate[]>(strFromU8(entries[PACKAGE_PATHS.promptTemplates] ?? strFromBytesEmptyArray())) ?? [];
  const unificationReport =
    parseJson<UnificationReport | null>(strFromU8(entries[PACKAGE_PATHS.unification] ?? strFromBytesNull())) ?? null;

  // Chapters: read every chapters/NNNN.json the zip carries.
  const chapters: BackupChapter[] = [];
  for (const path of Object.keys(entries)) {
    if (!path.startsWith(PACKAGE_PATHS.chaptersDir) || !path.endsWith('.json')) continue;
    const ch = parseJson<BackupChapter>(strFromU8(entries[path]));
    if (!ch) {
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
  const entryIds = new Set(knowledgeEntries.map(e => e.id));
  for (const rel of knowledgeRelations) {
    if (!entryIds.has(rel.sourceId)) {
      errors.push({ code: 'dangling_relation', detail: `Relation ${rel.id} source ${rel.sourceId} is missing from entries.`, ref: rel.id });
    }
    if (!entryIds.has(rel.targetId)) {
      errors.push({ code: 'dangling_relation', detail: `Relation ${rel.id} target ${rel.targetId} is missing from entries.`, ref: rel.id });
    }
  }

  const chapterNumbers = new Set(chapters.map(c => c.chapterNumber));
  for (const row of outline) {
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

  // --- Count cross-check (manifest vs actual; mismatch is a warning) ---
  const actualCounts = {
    chapters: chapters.length,
    knowledgeEntries: knowledgeEntries.length,
    knowledgeRelations: knowledgeRelations.length,
    outline: outline.length,
    promptTemplates: promptTemplates.length,
    attachments: attachments.length,
  };
  for (const [k, v] of Object.entries(actualCounts) as [keyof typeof actualCounts, number][]) {
    if (manifest.counts && manifest.counts[k] !== v) {
      warnings.push({
        code: 'count_mismatch',
        detail: `Manifest count for ${k} (${manifest.counts[k]}) differs from actual (${v}).`,
        ref: k,
      });
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

// fflate's strFromU8 needs a Uint8Array; these supply a default payload when a
// section file is entirely absent (so the parse degrades to []/null cleanly).
function strFromBytesEmptyArray(): Uint8Array {
  return strFromBytesCache('[]');
}
function strFromBytesNull(): Uint8Array {
  return strFromBytesCache('null');
}
const _enc = new TextEncoder();
function strFromBytesCache(s: string): Uint8Array {
  return _enc.encode(s);
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
