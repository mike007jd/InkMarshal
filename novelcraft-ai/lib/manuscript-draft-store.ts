/**
 * Crash-safe persistence for unsaved manuscript drafts.
 *
 * The editing view keeps unsaved text in memory (pendingContentRef) and the
 * shell mirrors it in draftContentByChapter, but neither survives a crash or
 * force-quit. This store mirrors every novel's draft map into the fixed
 * SQLite-backed app-setting key so recovery is independent of the desktop
 * runtime port. The app-settings client also maintains a localStorage mirror.
 *
 * Safety rule: a stored draft is only restored when the chapter's current
 * version still equals the version the draft was taken against AND the
 * content differs. If the DB moved on (a later save landed, another window
 * wrote, or a later autosave succeeded), the stale draft is dropped instead
 * of clobbering newer text.
 */

import {
  getStoredSetting,
  removeStoredSettingDurable,
  setStoredSettingDurable,
} from '@/lib/app-settings-client';

export interface PersistedDraft {
  content: string;
  /** Chapter version the draft was taken against (optimistic-concurrency base). */
  version: number;
  savedAt: number;
}

export type PersistedDraftMap = Record<string, PersistedDraft>;
type PersistedRecoveryEnvelope = Record<string, PersistedDraftMap>;

interface ChapterLike {
  chapterNumber: number;
  content: string;
  version?: number;
}

export const MANUSCRIPT_RECOVERY_SETTING_KEY = 'inkmarshal_manuscript_recovery_v1';

export class CorruptManuscriptRecoveryError extends Error {
  constructor(detail: string) {
    super(`Stored manuscript recovery data is corrupt (${detail}). It was left unchanged; reset it explicitly after preserving any recoverable text.`);
    this.name = 'CorruptManuscriptRecoveryError';
  }
}

function parseDraftMap(value: unknown, context: string): PersistedDraftMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CorruptManuscriptRecoveryError(`${context} is not an object`);
  }
  const out: PersistedDraftMap = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new CorruptManuscriptRecoveryError(`${context}.${key} is invalid`);
    }
    const draft = candidate as Partial<PersistedDraft>;
    if (
      typeof draft.content !== 'string' ||
      !Number.isInteger(draft.version) ||
      (draft.savedAt !== undefined && typeof draft.savedAt !== 'number')
    ) {
      throw new CorruptManuscriptRecoveryError(`${context}.${key} has an invalid draft shape`);
    }
    out[key] = {
      content: draft.content,
      version: draft.version as number,
      savedAt: typeof draft.savedAt === 'number' ? draft.savedAt : 0,
    };
  }
  return out;
}

function loadRecoveryEnvelope(): PersistedRecoveryEnvelope {
  const raw = getStoredSetting(MANUSCRIPT_RECOVERY_SETTING_KEY);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptManuscriptRecoveryError('payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CorruptManuscriptRecoveryError('payload is not an object');
  }
  const out: PersistedRecoveryEnvelope = {};
  for (const [novelId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const drafts = parseDraftMap(value, novelId);
    if (Object.keys(drafts).length > 0) out[novelId] = drafts;
  }
  return out;
}

export function loadPersistedDrafts(novelId: string): PersistedDraftMap {
  return loadRecoveryEnvelope()[novelId] ?? {};
}

export function persistDrafts(novelId: string, drafts: PersistedDraftMap): Promise<boolean> {
  const envelope = loadRecoveryEnvelope();
  const sanitized = parseDraftMap(drafts, novelId);
  if (Object.keys(sanitized).length === 0) delete envelope[novelId];
  else envelope[novelId] = sanitized;

  if (Object.keys(envelope).length === 0) {
    return removeStoredSettingDurable(MANUSCRIPT_RECOVERY_SETTING_KEY);
  } else {
    return setStoredSettingDurable(MANUSCRIPT_RECOVERY_SETTING_KEY, JSON.stringify(envelope));
  }
}

/**
 * Build the persisted payload for the current in-memory draft map.
 * `draftVersions` carries the editing view's live version base per chapter
 * (more current than the chapter prop after a save round-trip); chapters are
 * the fallback for drafts whose version was never reported.
 */
export function buildPersistPayload(
  draftContentByChapter: ReadonlyMap<number, string>,
  draftVersions: ReadonlyMap<number, number>,
  chapters: readonly ChapterLike[],
  now: number,
): PersistedDraftMap {
  const out: PersistedDraftMap = {};
  const chapterByNumber = indexByChapterNumber(chapters);
  for (const [chapterNumber, content] of draftContentByChapter) {
    const version = draftVersions.get(chapterNumber)
      ?? chapterByNumber.get(chapterNumber)?.version
      ?? 0;
    out[String(chapterNumber)] = { content, version, savedAt: now };
  }
  return out;
}

function indexByChapterNumber<T extends ChapterLike>(chapters: readonly T[]): Map<number, T> {
  return new Map(chapters.map(ch => [ch.chapterNumber, ch]));
}

/**
 * Decide which stored drafts are still safe to restore against the freshly
 * loaded chapter list. Returns the drafts to restore plus whether the stored
 * payload had entries that are now stale (so the caller can prune storage).
 */
export function reconcilePersistedDrafts(
  stored: PersistedDraftMap,
  chapters: readonly ChapterLike[],
): { restored: Map<number, string>; hadStaleEntries: boolean } {
  const restored = new Map<number, string>();
  let hadStaleEntries = false;
  const chapterByNumber = indexByChapterNumber(chapters);
  for (const [key, draft] of Object.entries(stored)) {
    const chapterNumber = Number(key);
    const chapter = chapterByNumber.get(chapterNumber);
    if (!chapter) {
      hadStaleEntries = true;
      continue;
    }
    const currentVersion = chapter.version ?? 0;
    if (draft.version !== currentVersion || draft.content === chapter.content) {
      hadStaleEntries = true;
      continue;
    }
    restored.set(chapterNumber, draft.content);
  }
  return { restored, hadStaleEntries };
}
