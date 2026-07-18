// Project-backup (W1-3) shared types + secret-stripping policy.
//
// A `.inkmarshal` package is a fflate zip with a fixed layout (see
// build-package.ts). `BackupBundle` is the in-memory aggregate the extractor
// produces and the package builder serializes; `InkmarshalManifest` is the
// top-level `manifest.json` carrying integrity + provenance.
//
// This module is pure (no DB / native / React imports) so it can be shared by
// extract / build / verify / restore and unit-tested in isolation.

import type {
  ChapterSnapshot,
  ChapterKeyFacts,
  ChapterQualityIssue,
  ChapterGenerationMeta,
  NovelSettings,
  UnificationReport,
} from '@/lib/db-types';

/**
 * Package format version. INDEPENDENT of the SQLite `dbSchemaVersion`: it
 * versions the on-disk `.inkmarshal` layout, not the database. Verify refuses a
 * package whose MAJOR differs from {@link FORMAT_VERSION} (a breaking layout
 * change); MINOR bumps stay forward/backward readable.
 */
export const FORMAT_VERSION = '1.0';

/** Canonical package file/dir names. Single source for build + verify + restore. */
export const PACKAGE_PATHS = {
  manifest: 'manifest.json',
  novel: 'novel.json',
  chaptersDir: 'chapters/',
  knowledgeEntries: 'knowledge/entries.json',
  knowledgeRelations: 'knowledge/relations.json',
  outline: 'outline.json',
  unification: 'unification.json',
  promptTemplates: 'prompt-templates.json',
  attachmentsDir: 'attachments/',
} as const;

/** Zip path for chapter N (zero-padded, stable sort). */
export function chapterEntryPath(chapterNumber: number): string {
  return `${PACKAGE_PATHS.chaptersDir}${String(chapterNumber).padStart(4, '0')}.json`;
}

/** File extension the restore dialog accepts (Rust read_local_file whitelist). */
export const BACKUP_EXTENSIONS = ['inkmarshal', 'zip'] as const;

/**
 * Case-insensitive secret-key blacklist. Any settings key whose lowercased name
 * CONTAINS one of these tokens (or matches {@link SECRET_KEY_REGEX}) is stripped
 * recursively at extract time — the package never carries an API key, token, or
 * credential. Stripping at the source is safer than filtering on restore: a
 * package on disk can be inspected, copied, or shared.
 */
export const SECRET_KEYS = [
  'apikey',
  'api_key',
  'token',
  'secret',
  'credential',
  'authorization',
  'password',
  'passphrase',
  'privatekey',
  'private_key',
  'accesskey',
  'access_key',
] as const;

/**
 * Matches a key that embeds any secret token even with separators/camelCase
 * (e.g. `openAiApiKey`, `auth-token`, `x_secret_2`). Anchored on word-ish
 * boundaries so an innocent key like `tokenizerCount` containing "token" is
 * still caught (intentional over-strip — a backup must never leak a secret, and
 * settings hold no field that legitimately needs "token"/"secret"/"key" with a
 * credential connotation).
 */
export const SECRET_KEY_REGEX =
  /(api[\s_-]?key|access[\s_-]?key|secret|token|credential|authorization|password|passphrase|private[\s_-]?key|bearer)/i;

/** Returns true when a settings key name should be stripped from a backup. */
export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SECRET_KEYS.some(s => lower.includes(s))) return true;
  return SECRET_KEY_REGEX.test(key);
}

// --- Serialized package payloads (1:1 with the fixed zip layout) ---

/** novel.json — the novel record minus runtime-only / secret fields. */
export interface BackupNovel {
  title: string;
  genre: string;
  targetWords: number;
  stage: string;
  progress: number;
  storySummary: string;
  characterSummary: string;
  arcSummary: string;
  interviewState: Record<string, unknown> | null;
  /** Settings with all secret keys recursively removed. `backup` policy is kept
   *  (it is not a secret) so the restored copy inherits the cadence. */
  settings: NovelSettings | null;
  createdAt: number;
  updatedAt: number;
}

/** One chapter file (chapters/NNNN.json). */
export interface BackupChapter {
  chapterNumber: number;
  title: string;
  content: string;
  originalContent: string | null;
  wordCount: number;
  version: number;
  summary: string;
  keyFacts: ChapterKeyFacts | null;
  qualityIssues: ChapterQualityIssue[] | null;
  generationMeta: ChapterGenerationMeta | null;
  snapshots: ChapterSnapshot[] | null;
  createdAt: number;
}

/** One knowledge entry (knowledge/entries.json is an array of these). The `data`
 *  / `tags` columns are kept verbatim as JSON text — restore re-parses them. */
export interface BackupKnowledgeEntry {
  id: string;
  type: string;
  title: string;
  summary: string;
  data: string;
  sortOrder: number;
  tags: string;
  createdAt: string;
  updatedAt: string;
}

/** One knowledge relation (knowledge/relations.json is an array of these). */
export interface BackupKnowledgeRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  label: string;
  createdAt: string;
}

/** outline.json — projected outline rows with their chapter linkage. Captured
 *  separately from knowledge entries so the restore can resync sort order +
 *  chapterNumber via reorderOutlineAtomic after remapping. */
export interface BackupOutlineRow {
  /** Knowledge-entry id of this outline row (same id space as entries). */
  entryId: string;
  chapterNumber: number;
  /** Old chapter id this outline row links to (remapped on restore), '' if unset. */
  chapterId: string;
  sortOrder: number;
}

/** One active prompt template the novel actually used (snapshot, not the whole
 *  global table). Restore upserts these, bumping `version` on conflict. */
export interface BackupPromptTemplate {
  stage: string;
  role: 'user' | 'system';
  locale: string;
  variant: string;
  version: number;
  templateText: string;
  variablesSchema: string;
}

/** One binary attachment (attachments/<name>). Forward-compat: no DB table
 *  produces these yet, so the array is empty today but the layout reserves it. */
export interface BackupAttachment {
  name: string;
  contentsBase64: string;
}

/** The full in-memory aggregate produced by extract and consumed by build. */
export interface BackupBundle {
  novel: BackupNovel;
  chapters: BackupChapter[];
  knowledgeEntries: BackupKnowledgeEntry[];
  knowledgeRelations: BackupKnowledgeRelation[];
  outline: BackupOutlineRow[];
  unificationReport: UnificationReport | null;
  promptTemplates: BackupPromptTemplate[];
  attachments: BackupAttachment[];
  /** Provenance captured at extract time; folded into the manifest by build. */
  meta: {
    appVersion: string;
    dbSchemaVersion: number;
    sourceNovelId: string;
    exportedAt: string;
  };
}

/** Per-section record counts (cross-checked by verify against the actual files). */
export interface BackupCounts {
  chapters: number;
  knowledgeEntries: number;
  knowledgeRelations: number;
  outline: number;
  promptTemplates: number;
  attachments: number;
}

/**
 * manifest.json — top-level integrity + provenance. `sha256` maps every
 * packaged file path (except the manifest itself) to the hex SHA-256 of its
 * exact bytes, so verify can detect any single-byte tamper.
 */
export interface InkmarshalManifest {
  formatVersion: string;
  appVersion: string;
  dbSchemaVersion: number;
  exportedAt: string;
  /** Source novel title (display only — restore always mints a fresh id). */
  novelTitle: string;
  counts: BackupCounts;
  /** path -> hex sha256 of that file's bytes. */
  sha256: Record<string, string>;
  /** Always true: extract strips secrets at the source. */
  secretsStripped: true;
}
