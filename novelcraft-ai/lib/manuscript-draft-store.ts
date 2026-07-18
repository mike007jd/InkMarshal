/**
 * Crash-safe persistence for unsaved manuscript drafts.
 *
 * The editing view keeps unsaved text in memory (pendingContentRef) and the
 * shell mirrors it in draftContentByChapter, but neither survives a crash or
 * force-quit. This store mirrors that map into localStorage so a draft whose
 * save failed (or that was mid-debounce when the app died) can be recovered
 * on the next launch.
 *
 * Safety rule: a stored draft is only restored when the chapter's current
 * version still equals the version the draft was taken against AND the
 * content differs. If the DB moved on (a later save landed, another window
 * wrote, the beforeunload keepalive PATCH succeeded), the stale draft is
 * dropped instead of clobbering newer text.
 */

export interface PersistedDraft {
  content: string;
  /** Chapter version the draft was taken against (optimistic-concurrency base). */
  version: number;
  savedAt: number;
}

export type PersistedDraftMap = Record<string, PersistedDraft>;

interface ChapterLike {
  chapterNumber: number;
  content: string;
  version?: number;
}

const KEY_PREFIX = 'inkmarshal:manuscript-drafts:v1:';

function draftStorageKey(novelId: string): string {
  return `${KEY_PREFIX}${novelId}`;
}

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadPersistedDrafts(novelId: string): PersistedDraftMap {
  const storage = safeStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(draftStorageKey(novelId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PersistedDraftMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^\d+$/.test(key)) continue;
      if (!value || typeof value !== 'object') continue;
      const draft = value as Partial<PersistedDraft>;
      if (typeof draft.content !== 'string' || typeof draft.version !== 'number') continue;
      out[key] = {
        content: draft.content,
        version: draft.version,
        savedAt: typeof draft.savedAt === 'number' ? draft.savedAt : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function persistDrafts(novelId: string, drafts: PersistedDraftMap): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    if (Object.keys(drafts).length === 0) {
      storage.removeItem(draftStorageKey(novelId));
    } else {
      storage.setItem(draftStorageKey(novelId), JSON.stringify(drafts));
    }
  } catch {
    // Quota / private-mode failures are non-fatal: in-memory state and the
    // normal save pipeline still protect the draft for this session.
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
