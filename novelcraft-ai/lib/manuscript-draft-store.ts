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
  removeStoredSetting,
  setStoredSetting,
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

function sanitizeDraftMap(value: unknown): PersistedDraftMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: PersistedDraftMap = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || !candidate || typeof candidate !== 'object') continue;
    const draft = candidate as Partial<PersistedDraft>;
    if (typeof draft.content !== 'string' || typeof draft.version !== 'number') continue;
    out[key] = {
      content: draft.content,
      version: draft.version,
      savedAt: typeof draft.savedAt === 'number' ? draft.savedAt : 0,
    };
  }
  return out;
}

function loadRecoveryEnvelope(): PersistedRecoveryEnvelope {
  try {
    const raw = getStoredSetting(MANUSCRIPT_RECOVERY_SETTING_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PersistedRecoveryEnvelope = {};
    for (const [novelId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const drafts = sanitizeDraftMap(value);
      if (Object.keys(drafts).length > 0) out[novelId] = drafts;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadPersistedDrafts(novelId: string): PersistedDraftMap {
  return loadRecoveryEnvelope()[novelId] ?? {};
}

export function persistDrafts(novelId: string, drafts: PersistedDraftMap): void {
  const envelope = loadRecoveryEnvelope();
  const sanitized = sanitizeDraftMap(drafts);
  if (Object.keys(sanitized).length === 0) delete envelope[novelId];
  else envelope[novelId] = sanitized;

  if (Object.keys(envelope).length === 0) {
    removeStoredSetting(MANUSCRIPT_RECOVERY_SETTING_KEY);
  } else {
    setStoredSetting(MANUSCRIPT_RECOVERY_SETTING_KEY, JSON.stringify(envelope));
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
