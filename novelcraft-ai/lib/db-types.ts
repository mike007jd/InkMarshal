// Pure local-domain types + row mappers + constants shared by the SQLite store
// and API surfaces.
//
// INVARIANT: the mappers take a snake_case row object and return the domain
// type. The local path feeds them SQLite rows selected with snake_case column
// aliases and JSON columns already `JSON.parse`d. Keep this module storage-
// adapter neutral: no native, route, or UI imports.

import { parseTimestamp } from '@/lib/utils';
import type { NovelStage } from '@/lib/novel-stages';

// --- Domain types ---

export interface ChapterBlueprintEntry {
  chapterNumber: number;
  title: string;
  summary: string;
}

export interface NovelBlueprint {
  chapters: ChapterBlueprintEntry[];
  targetWordsPerChapter: number;
  generatedAt: string;
  modelId: string;
}

export interface ChapterKeyFacts {
  characters: string[];
  locations: string[];
  items: string[];
  plotMoves: string[];
}

export interface ChapterQualityIssue {
  type: 'character_name' | 'setting' | 'timeline' | 'pov' | 'length' | 'other';
  description: string;
  severity: 'minor' | 'major';
}

export interface ChapterGenerationMeta {
  targetWords: number;
  actualWords: number;
  attempts: number;
  modelId: string;
  generatedAt: string;
  ralphLoop?: {
    revisionCount: number;
    finalScore: number | null;
    fixedIssues: number;
  };
  /** True when `content` changed after `summary` was generated (manual edit,
   *  unification fix, snapshot restore). Context assembly must not feed the
   *  stale summary to the model — see markChapterSummaryStale. */
  summaryStale?: boolean;
}

/**
 * One manual snapshot of a chapter's content. Stored as JSON in
 * `chapters.snapshots`. The list is capped at SNAPSHOT_MAX entries (oldest
 * evicted first). `label` may be empty when the user didn't name it.
 */
export interface ChapterSnapshot {
  id: string;
  createdAt: number;
  label: string;
  content: string;
}

/** Cap on stored snapshots per chapter. Keep in sync with the docs in
 *  `0008_chapter_snapshots.ts` and the `snapshotLimitNotice` i18n key. */
export const SNAPSHOT_MAX = 10;

export interface UnificationEdit {
  id: string;
  chapterNumber: number;
  original: string;
  replacement: string;
  rationale: string;
  severity: 'minor' | 'major';
  applied?: boolean;
  appliedAt?: string;
  skipped?: boolean;
  skippedAt?: string;
}

export interface UnificationReport {
  edits: UnificationEdit[];
  summary: string;
  generatedAt: string;
  modelId: string;
}

/** Author-facing project work status. Orthogonal to (and never written by)
 *  `novels.stage` — it tracks the editorial phase a human is in, while `stage`
 *  guards the generation pipeline. See command-center. */
export type WorkStatus =
  | 'ideation'
  | 'drafting'
  | 'structural_revision'
  | 'line_revision'
  | 'proofreading'
  | 'delivery';

/** Metadata recorded when an existing manuscript is imported (manuscript-import). */
export interface ImportMeta {
  source: 'txt' | 'md' | 'docx';
  importedAt: string;
  originalFilename: string;
  detectedChapters: number;
  kbExtraction?: 'pending' | 'done' | 'failed';
}

/** Front/back-matter section toggle for the publishing workspace. */
export interface PublishingSection {
  enabled: boolean;
  body?: string;
}

/** Publishing workspace configuration (publishing-workspace). Applied only at
 *  export/preview time — the plain-text manuscript is never mutated. */
export interface PublishingConfig {
  metadata: {
    author?: string;
    subtitle?: string;
    isbn?: string;
    publisher?: string;
    language?: string;
    copyrightYear?: string;
    rightsNotice?: string;
    description?: string;
    coverPlaceholderText?: string;
  };
  frontMatter: {
    titlePage: PublishingSection;
    copyrightPage: PublishingSection;
    toc: PublishingSection;
    dedication: PublishingSection;
    acknowledgements: PublishingSection;
    authorBio: PublishingSection;
  };
  layout: {
    chapterStartStyle: 'newPage' | 'newRecto' | 'continuous';
    trim: 'a5' | 'b6' | '6x9' | 'digital';
    marginsMm: number;
    header?: string;
    footer?: string;
  };
  activePreset: 'submission' | 'editorial' | 'publication';
}

/**
 * Per-novel user/UI settings bag. Stored as a JSON text column so the shape
 * can grow without DDL changes. NULL on the DB side is interpreted as "use
 * application defaults" — see OPERATION_DEFAULT_CREATIVITY for creativity.
 *
 * Low-frequency per-novel config lives here (no DDL). Only unbounded /
 * SQL-aggregated record sets get their own tables (activity_events, ai_runs,
 * series).
 */
export interface NovelSettings {
  /** Reversible library removal. Trashed novels stay intact but are excluded
   *  from every ordinary authoring surface until explicitly restored. */
  trashedAt?: string;

  /** UI creativity level chosen by the user; consumed server-side via the
   *  `x-im-creativity` header path. Stored per-novel so a brainstorm draft
   *  ("wild") and a polished novel ("conservative") can coexist. */
  creativity?: 'conservative' | 'balanced' | 'wild';

  // -- command-center (project goals; orthogonal to novels.stage) --
  /** Deadline as ISO date (YYYY-MM-DD). */
  deadline?: string;
  dailyWordGoal?: number;
  weeklyWordGoal?: number;
  workStatus?: WorkStatus;

  // -- manuscript-import --
  importMeta?: ImportMeta;

  // -- template-editor (prompt variant selection) --
  /** Whole-novel default prompt variant. */
  promptVariant?: string;
  /** Per-stage variant overrides; keyed by prompt stage. */
  promptVariants?: Partial<Record<string, string>>;

  // -- publishing-workspace --
  publishing?: PublishingConfig;
}

export interface Novel {
  id: string;
  userId: string;
  title: string;
  genre: string;
  targetWords: number;
  stage: NovelStage;
  progress: number;
  storySummary: string;
  characterSummary: string;
  arcSummary: string;
  interviewState?: Record<string, unknown> | null;
  /**
   * W2-D: the `blueprint` column was dropped — outline knowledge entries are
   * the truth source. This field is now an **optional projection** populated
   * by API routes / streaming events that want to ship the blueprint alongside
   * the novel record (e.g. start-writing stream, manuscript-session resume
   * gate). It is always `null` on a fresh `getNovel()` from SQLite; callers
   * needing the live blueprint call `getNovelBlueprint(id)` (which delegates
   * to the outline projector).
   */
  blueprint?: NovelBlueprint | null;
  writingLockToken?: string | null;
  writingLockExpiresAt?: number | null;
  unificationReport?: UnificationReport | null;
  /** See {@link NovelSettings}. Null/absent => use defaults. */
  settings?: NovelSettings | null;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  novelId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  conversationId?: string | null;
  createdAt: number;
}

export interface Chapter {
  id: string;
  novelId: string;
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
  /** Manual snapshot history; null/empty when the user hasn't taken any
   *  snapshot yet. See {@link ChapterSnapshot}. Optional so test fixtures and
   *  helper builders that pre-date schema v8 stay compatible. */
  snapshots?: ChapterSnapshot[] | null;
  createdAt: number;
}

export type ChapterLite = Omit<Chapter, 'content' | 'originalContent' | 'keyFacts' | 'qualityIssues' | 'generationMeta' | 'snapshots'>;

export interface WritingLockInfo {
  token: string;
  expiresAt: number;
}

export interface ChapterMetaUpdate {
  summary?: string;
  keyFacts?: ChapterKeyFacts | null;
  qualityIssues?: ChapterQualityIssue[] | null;
  generationMeta?: ChapterGenerationMeta | null;
}

// --- Row shapes (snake_case, as returned by aliased SQLite SELECTs) ---

export interface NovelRow {
  id: string;
  user_id: string;
  title: string;
  genre: string;
  target_words: number;
  stage: string;
  progress: number;
  story_summary: string;
  character_summary: string;
  arc_summary: string;
  interview_state: Record<string, unknown> | null;
  /**
   * W2-D: the `blueprint` column was dropped. The hydrator always sets this to
   * null so the field stays present on the row type (and downstream `mapNovel`
   * sees a stable shape), but no SQLite read populates it any more. Live
   * blueprint access goes through `getNovelBlueprint(id)`.
   */
  blueprint: NovelBlueprint | null;
  writing_lock_token: string | null;
  writing_lock_expires_at: string | null;
  unification_report: UnificationReport | null;
  settings: NovelSettings | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  novel_id: string;
  role: string;
  content: string;
  conversation_id: string | null;
  created_at: string;
}

export interface ChapterRow {
  id: string;
  novel_id: string;
  chapter_number: number;
  title: string;
  content: string;
  original_content: string | null;
  word_count: number;
  version?: number;
  summary?: string | null;
  key_facts?: ChapterKeyFacts | null;
  quality_issues?: ChapterQualityIssue[] | null;
  generation_meta?: ChapterGenerationMeta | null;
  snapshots?: ChapterSnapshot[] | null;
  created_at: string;
}

// --- Mappers (pure: snake_case row -> domain type) ---

export function mapNovel(row: NovelRow): Novel {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    genre: row.genre || '',
    targetWords: row.target_words ?? 80000,
    stage: (row.stage || 'discovery_interview') as NovelStage,
    progress: row.progress ?? 0,
    storySummary: row.story_summary || '',
    characterSummary: row.character_summary || '',
    arcSummary: row.arc_summary || '',
    interviewState: row.interview_state ?? null,
    blueprint: row.blueprint ?? null,
    writingLockToken: row.writing_lock_token ?? null,
    writingLockExpiresAt: row.writing_lock_expires_at
      ? parseTimestamp(row.writing_lock_expires_at)
      : null,
    unificationReport: row.unification_report ?? null,
    settings: row.settings ?? null,
    createdAt: parseTimestamp(row.created_at),
    updatedAt: parseTimestamp(row.updated_at),
  };
}

export function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    novelId: row.novel_id,
    role: row.role as Message['role'],
    content: row.content,
    conversationId: row.conversation_id ?? null,
    createdAt: parseTimestamp(row.created_at),
  };
}

export function mapChapter(row: ChapterRow): Chapter {
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterNumber: row.chapter_number,
    title: row.title,
    content: row.content,
    originalContent: row.original_content ?? null,
    wordCount: row.word_count ?? 0,
    version: row.version ?? 0,
    summary: row.summary ?? '',
    keyFacts: row.key_facts ?? null,
    qualityIssues: row.quality_issues ?? null,
    generationMeta: row.generation_meta ?? null,
    snapshots: row.snapshots ?? null,
    createdAt: parseTimestamp(row.created_at),
  };
}

export function mapChapterLite(row: ChapterRow): ChapterLite {
  return {
    id: row.id,
    novelId: row.novel_id,
    chapterNumber: row.chapter_number,
    title: row.title,
    wordCount: row.word_count ?? 0,
    version: row.version ?? 0,
    summary: row.summary ?? '',
    createdAt: parseTimestamp(row.created_at),
  };
}

// --- Constants ---

export const CHAT_HISTORY_KEEP = 50;

export const NOVEL_WRITABLE_FIELDS = ['title', 'genre', 'targetWords'] as const;

// W2-D: `blueprint` left this list when the column was dropped. Outline rows
// in `knowledge_entries` are now the truth source — callers that
// want to mutate the plan go through `setNovelBlueprint(novelId, blueprint)`.
export const NOVEL_INTERNAL_FIELDS = [
  'title', 'genre', 'targetWords', 'stage', 'progress',
  'storySummary', 'characterSummary', 'arcSummary', 'interviewState',
  'unificationReport', 'settings',
] as const;

export const FIELD_TO_COLUMN: Record<string, string> = {
  title: 'title',
  genre: 'genre',
  targetWords: 'target_words',
  stage: 'stage',
  progress: 'progress',
  storySummary: 'story_summary',
  characterSummary: 'character_summary',
  arcSummary: 'arc_summary',
  interviewState: 'interview_state',
  unificationReport: 'unification_report',
  settings: 'settings',
};
