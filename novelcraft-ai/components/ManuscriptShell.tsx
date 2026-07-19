'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ListTree } from 'lucide-react';
import { countWords } from '@/lib/utils';
import { useLanguage } from '@/components/LanguageProvider';
import { ManuscriptSidebar } from './ManuscriptSidebar';
import { ManuscriptReadingView, type ReadingLayout } from './ManuscriptReadingView';
import { ManuscriptEditingView, type ManuscriptEditingViewHandle } from './ManuscriptEditingView';
import { SaveStatusIndicator, type SaveState } from './SaveStatusIndicator';
import { WritingModelDotBadge } from './WritingModelDotBadge';
import { useRegisterSearchScope, type ManuscriptScope } from './search/GlobalSearchProvider';
import type { CreativityLevel } from '@/lib/ai/generation-presets';
import { MANUSCRIPT_FLUSH_EVENT, type ManuscriptFlushEventDetail } from '@/lib/desktop-shell-bus';
import { onAppSettingsHydrated } from '@/lib/app-settings-client';
import { isTauriRuntime } from '@/lib/desktop-runtime';
import {
  buildPersistPayload,
  loadPersistedDrafts,
  persistDrafts,
  reconcilePersistedDrafts,
} from '@/lib/manuscript-draft-store';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

export interface ManuscriptChapter {
  id: string;
  chapterNumber: number;
  title: string;
  content: string;
  version?: number;
  /** When non-null, the chapter has an AI-generated first draft that the user
   *  can revert to via the RevertChapterButton. */
  originalContent?: string | null;
}

interface ManuscriptShellProps {
  novelId: string;
  title: string;
  genre: string;
  storySummary?: string;
  characterSummary?: string;
  arcSummary?: string;
  progress: number;
  mode: 'writing-live' | 'reading-review';
  chapters: ManuscriptChapter[];
  liveChapter: ManuscriptChapter | null;
  onChaptersChange?: () => void;
  /** When true, lock to reading mode (no editor, no API writes). Used by
      example previews. */
  readOnly?: boolean;
  /** Persisted per-novel creativity (Novel.settings.creativity). Forwarded to
   *  the editing view so the picker initial value matches the server value
   *  on first render. Null/undefined => UI default (see useNovelCreativity). */
  initialCreativity?: CreativityLevel | null;
  /** Chapter number requested by a URL/deep link. Applied once per request. */
  requestedChapter?: number | null;
  /** Character offset requested by a cross-book search deep link. */
  requestedOffset?: number | null;
  /** Open directly in the editor for explicit blank-manuscript deep links. */
  startInEditing?: boolean;
  /** True when the novel's stage still allows generating chapters (Continue).
   *  Gates the standalone writing-model status row in READING mode: reading is
   *  consumption, so on a finished novel (no Continue available) that row — and
   *  its full "no model bound" warning bar in the unbound state — is pure chrome
   *  stealing height above the prose. Editing mode always shows it (polish needs
   *  a model regardless of stage). */
  canContinueWriting?: boolean;
}

const LAYOUT_STORAGE_KEY = 'manuscript:readingLayout';
/** Crash-safety window: unsaved drafts hit the recovery store at most this far behind. */
const DRAFT_PERSIST_DEBOUNCE_MS = 250;

function readPersistedLayout(): ReadingLayout {
  if (typeof window === 'undefined') return 'continuous';
  try {
    const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (stored === 'flipbook' || stored === 'continuous') return stored;
  } catch {
    // localStorage can throw in private-mode safari etc.
  }
  return 'continuous';
}

export function failedDraftSaveOutcome(
  draftContentByChapter: ReadonlyMap<number, string>,
  chapters: readonly ManuscriptChapter[],
) {
  if (draftContentByChapter.size === 0) return null;
  const firstDirty = [...draftContentByChapter.keys()].sort((a, b) => a - b)[0];
  const dirtyChapter = chapters.find(ch => ch.chapterNumber === firstDirty);
  return {
    ok: false,
    chapterNumber: firstDirty,
    title: dirtyChapter?.title,
  };
}

export function applyDraftContentToChapters(
  chapters: readonly ManuscriptChapter[],
  draftContentByChapter: ReadonlyMap<number, string>,
): ManuscriptChapter[] {
  return chapters.map(ch => {
    const draft = draftContentByChapter.get(ch.chapterNumber);
    return draft === undefined ? ch : { ...ch, content: draft };
  });
}

export function draftContentForActiveChapter(
  chapter: ManuscriptChapter | null,
  draftContentByChapter: ReadonlyMap<number, string>,
) {
  return chapter ? draftContentByChapter.get(chapter.chapterNumber) : undefined;
}

export function ManuscriptShell({
  novelId, title, genre, storySummary, characterSummary, arcSummary,
  progress, mode,
  chapters, liveChapter, onChaptersChange,
  readOnly = false,
  initialCreativity = null,
  requestedChapter = null,
  requestedOffset = null,
  startInEditing = false,
  canContinueWriting = false,
}: ManuscriptShellProps) {
  const { t } = useLanguage();
  const [viewMode, setViewMode] = useState<'reading' | 'editing'>(
    startInEditing && !readOnly ? 'editing' : 'reading',
  );
  const [activeChapter, setActiveChapter] = useState<number | null>(null);
  const [mobileChaptersOpen, setMobileChaptersOpen] = useState(false);
  const [layout, setLayoutState] = useState<ReadingLayout>(() => readPersistedLayout());
  const editingViewRef = useRef<ManuscriptEditingViewHandle | null>(null);
  // Auto-save state surfaced from ManuscriptEditingView so the shell can
  // render a SaveStatusIndicator next to the title / in the sidebar.
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [draftContentByChapter, setDraftContentByChapter] = useState<Map<number, string>>(() => new Map());
  const draftContentRef = useRef(new Map<number, string>());
  const [draftStoreReady, setDraftStoreReady] = useState(() => !isTauriRuntime());
  // Live optimistic-concurrency base per dirty chapter, reported by the
  // editing view (more current than the chapter prop after a save round-trip).
  const draftVersionsRef = useRef(new Map<number, number>());
  // novelId whose persisted drafts still need to be reconciled against the
  // loaded chapter list. Set by the novel-switch reset below so the restore
  // always runs AFTER the map reset (state update ordering guarantee).
  const [draftRestoreTarget, setDraftRestoreTarget] = useState<string | null>(novelId);
  const activeNovelRef = useRef(novelId);
  const appliedRequestedChapterKeyRef = useRef<string | null>(null);
  const searchJumpSeqRef = useRef(0);
  const appliedRequestedSearchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    return onAppSettingsHydrated(() => setDraftStoreReady(true));
  }, []);

  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1024px)');
    const closeOnWide = () => {
      if (wide.matches) setMobileChaptersOpen(false);
    };
    closeOnWide();
    wide.addEventListener('change', closeOnWide);
    return () => wide.removeEventListener('change', closeOnWide);
  }, []);
  const handleSaveStatusChange = useCallback((next: SaveState, at: number | null) => {
    setSaveState(next);
    setLastSavedAt(at);
  }, []);
  const handleSaveRetry = useCallback(() => {
    // The editing view also listens for `inkmarshal:manuscript-flush` and re-fires
    // the failed flush — using the same channel here keeps menus, the toast
    // action, and this indicator in lock-step.
    window.dispatchEvent(new CustomEvent(MANUSCRIPT_FLUSH_EVENT));
  }, []);

  const setLayout = useCallback((next: ReadingLayout) => {
    setLayoutState(next);
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, next);
    } catch {
      // ignore
    }
  }, []);

  const isWritingLive = mode === 'writing-live';
  const editingDisabled = isWritingLive || readOnly;
  const effectiveViewMode = editingDisabled ? 'reading' : viewMode;
  const effectiveActiveChapter = activeChapter ?? chapters[0]?.chapterNumber ?? null;
  // Editing always needs the model status (polish). Reading only shows it when a
  // Continue is still reachable; on a finished novel it would be dead chrome.
  const showWritingStatus = effectiveViewMode === 'editing' || isWritingLive || canContinueWriting;

  useEffect(() => {
    const saveNow = (event: Event) => {
      if (effectiveViewMode === 'editing' || draftContentByChapter.size === 0) return;
      // A dirty draft survived editor unmount, which means the last flush
      // failed. Do not let export/snapshot flows silently read stale DB
      // text. Surface the lowest-numbered orphaned chapter so the export
      // error can point the user at the specific tab to revisit.
      const outcome = failedDraftSaveOutcome(draftContentByChapter, chapters);
      if (outcome) {
        (event as CustomEvent<ManuscriptFlushEventDetail>).detail?.waitUntil?.(Promise.resolve(outcome));
      }
    };
    window.addEventListener(MANUSCRIPT_FLUSH_EVENT, saveNow);
    return () => window.removeEventListener(MANUSCRIPT_FLUSH_EVENT, saveNow);
  }, [draftContentByChapter, effectiveViewMode, chapters]);

  useLayoutEffect(() => {
    let cancelled = false;
    activeNovelRef.current = novelId;
    appliedRequestedChapterKeyRef.current = null;
    appliedRequestedSearchKeyRef.current = null;
    searchJumpSeqRef.current += 1;
    editingViewRef.current = null;
    draftVersionsRef.current = new Map();
    draftContentRef.current = new Map();
    queueMicrotask(() => {
      if (cancelled) return;
      setActiveChapter(null);
      setSaveState('idle');
      setLastSavedAt(null);
      setDraftContentByChapter(new Map());
      setDraftRestoreTarget(novelId);
    });
    return () => {
      cancelled = true;
    };
  }, [novelId]);

  const combinedChapters = useMemo(() => {
    if (!liveChapter) return chapters;
    return [...chapters.filter(ch => ch.chapterNumber !== liveChapter.chapterNumber), liveChapter]
      .sort((a, b) => a.chapterNumber - b.chapterNumber);
  }, [chapters, liveChapter]);
  const combinedChaptersRef = useRef(combinedChapters);
  useLayoutEffect(() => {
    combinedChaptersRef.current = combinedChapters;
  }, [combinedChapters]);

  const combinedChaptersWithDrafts = useMemo(() =>
    applyDraftContentToChapters(combinedChapters, draftContentByChapter),
    [combinedChapters, draftContentByChapter],
  );

  const handleDraftContentChange = useCallback((chapterNumber: number, content: string, dirty: boolean, version?: number) => {
    if (dirty && version !== undefined) draftVersionsRef.current.set(chapterNumber, version);
    else if (!dirty) draftVersionsRef.current.delete(chapterNumber);
    const next = new Map(draftContentRef.current);
    if (dirty) next.set(chapterNumber, content);
    else next.delete(chapterNumber);
    // Update synchronously so pagehide/beforeunload always sees the keystroke
    // that triggered this callback, even before React commits the state update.
    draftContentRef.current = next;
    setDraftContentByChapter(next);
  }, []);

  // --- Crash-safe draft persistence -------------------------------------
  // Mirror unsaved drafts into the app-settings recovery store so a crash/force-quit (where
  // beforeunload never fires) can't lose more than the debounce window.
  // The draft map is read through a ref so persistDraftMapNow stays stable
  // across keystrokes — otherwise the beforeunload listener below would be
  // removed and re-added on every edit.
  const persistDraftMapNow = useCallback(() => {
    if (activeNovelRef.current !== novelId) return;
    persistDrafts(novelId, buildPersistPayload(
      draftContentRef.current,
      draftVersionsRef.current,
      combinedChaptersRef.current,
      Date.now(),
    ));
  }, [novelId]);

  // draftContentByChapter is deliberately a dependency: every edit must
  // reset the debounce timer (that IS the debounce).
  useEffect(() => {
    if (!draftStoreReady || draftRestoreTarget !== null || readOnly) return;
    const handle = setTimeout(persistDraftMapNow, DRAFT_PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [persistDraftMapNow, draftContentByChapter, draftRestoreTarget, draftStoreReady, readOnly]);

  useEffect(() => {
    if (!draftStoreReady || readOnly) return;
    const flush = () => persistDraftMapNow();
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [draftStoreReady, persistDraftMapNow, readOnly]);

  // Restore persisted drafts once the chapter list for this novel is loaded.
  // Version-guarded: a draft is only restored when the chapter is still at
  // the version the draft was taken against, so a recovered draft can never
  // clobber newer DB content (see lib/manuscript-draft-store.ts).
  useEffect(() => {
    if (!draftStoreReady || readOnly || draftRestoreTarget === null || draftRestoreTarget !== novelId) return;
    if (chapters.length === 0 && liveChapter === null) return;
    const stored = loadPersistedDrafts(novelId);
    const { restored, hadStaleEntries } = reconcilePersistedDrafts(stored, combinedChaptersRef.current);
    if (restored.size > 0) {
      setDraftContentByChapter(prev => {
        const next = new Map(prev);
        for (const [chapterNumber, content] of restored) {
          if (!next.has(chapterNumber)) next.set(chapterNumber, content);
        }
        draftContentRef.current = next;
        return next;
      });
    }
    if (hadStaleEntries) {
      persistDrafts(novelId, buildPersistPayload(
        restored,
        draftVersionsRef.current,
        combinedChaptersRef.current,
        Date.now(),
      ));
    }
    setDraftRestoreTarget(null);
  }, [draftRestoreTarget, draftStoreReady, novelId, chapters, liveChapter, readOnly]);

  /** Add wordCount for sidebar */
  const sidebarChapters = useMemo(() =>
    combinedChaptersWithDrafts.map(ch => ({
      ...ch,
      wordCount: countWords(ch.content),
    })),
    [combinedChaptersWithDrafts],
  );

  const activeChapterData = useMemo(() =>
    combinedChapters.find(ch => ch.chapterNumber === effectiveActiveChapter) ?? null,
    [combinedChapters, effectiveActiveChapter],
  );
  const activeDraftContent = draftContentForActiveChapter(activeChapterData, draftContentByChapter);

  useEffect(() => {
    if (requestedChapter == null) {
      appliedRequestedChapterKeyRef.current = null;
      return;
    }
    const requestKey = `${novelId}:${requestedChapter}`;
    if (appliedRequestedChapterKeyRef.current === requestKey) return;
    if (!combinedChapters.some(ch => ch.chapterNumber === requestedChapter)) return;
    appliedRequestedChapterKeyRef.current = requestKey;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setActiveChapter(requestedChapter);
    });
    return () => {
      cancelled = true;
    };
  }, [combinedChapters, novelId, requestedChapter]);

  // Register a search scope for the lifetime of this shell. Scope re-registers
  // whenever the combined chapter list shifts (new draft, edit save, etc.).
  // onJump is the bridge from search results back into the shell — it picks
  // reading vs editing target based on the current view mode.
  const searchChapters = useMemo(
    () => combinedChapters.map(ch => ({
      chapterNumber: ch.chapterNumber,
      title: ch.title,
      content: draftContentByChapter.get(ch.chapterNumber) ?? ch.content,
    })),
    [combinedChapters, draftContentByChapter],
  );

  const handleSearchJump = useCallback((chapterNumber: number, offset: number) => {
    const requestNovelId = activeNovelRef.current;
    const seq = ++searchJumpSeqRef.current;
    setActiveChapter(chapterNumber);
    if (effectiveViewMode === 'editing') {
      // The editing view may not be mounted yet (chapter switch causes a
      // remount of the lexical composer). Schedule the offset jump after the
      // remount has a chance to settle.
      const tryJump = (retries: number) => {
        if (activeNovelRef.current !== requestNovelId || searchJumpSeqRef.current !== seq) return;
        if (editingViewRef.current) {
          editingViewRef.current.jumpToOffset(offset);
        } else if (retries > 0) {
          setTimeout(() => tryJump(retries - 1), 50);
        }
      };
      setTimeout(() => tryJump(8), 0);
    }
    // reading mode: scrollIntoView is handled by the reading view's
    // activeChapter effect — no extra work needed here.
  }, [effectiveViewMode]);

  useEffect(() => {
    if (requestedChapter == null || requestedOffset == null) return;
    if (!combinedChapters.some(ch => ch.chapterNumber === requestedChapter)) return;
    const requestKey = `${novelId}:${requestedChapter}:${requestedOffset}`;
    if (appliedRequestedSearchKeyRef.current === requestKey) return;
    appliedRequestedSearchKeyRef.current = requestKey;
    const id = window.setTimeout(() => handleSearchJump(requestedChapter, requestedOffset), 0);
    return () => window.clearTimeout(id);
  }, [combinedChapters, handleSearchJump, novelId, requestedChapter, requestedOffset]);

  const scope = useMemo<ManuscriptScope>(() => ({
    kind: 'manuscript',
    id: `manuscript:${novelId}`,
    novelId,
    chapters: searchChapters,
    onJump: handleSearchJump,
  }), [novelId, searchChapters, handleSearchJump]);

  useRegisterSearchScope(scope);

  // When layout changes and we have an activeChapter, the reading view's own
  // effect will re-sync. No work needed here.

  return (
    <div className="flex-1 flex flex-col overflow-hidden px-4 py-2 md:px-6 md:py-3">
      {/* Compact header (< lg) */}
      <div className="mb-2 lg:hidden shrink-0 rounded-lg border border-book-border bg-book-bg-sidebar/90 px-4 py-2 shadow-sm backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-serif text-lg leading-tight text-book-ink-primary">{title}</h2>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMobileChaptersOpen(true)}
            aria-label={t.manuscriptChapters}
            className="shrink-0 gap-1.5"
          >
            <ListTree className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t.manuscriptChapters}</span>
          </Button>
          {effectiveViewMode === 'editing' && (
            <SaveStatusIndicator
              state={saveState}
              lastSavedAt={lastSavedAt}
              onRetry={handleSaveRetry}
              density="compact"
            />
          )}
        </div>
        {showWritingStatus && (
          <div className="mt-2 overflow-hidden rounded-md border border-book-border bg-book-bg-card/70">
            <WritingModelDotBadge
              operation={effectiveViewMode === 'editing' ? 'polish' : 'chapter'}
              unboundDensity={effectiveViewMode === 'reading' ? 'compact' : 'strip'}
            />
          </div>
        )}
        <div className="mt-2 flex items-center justify-between gap-3">
          <ToggleGroup
            type="single"
            value={effectiveViewMode}
            onValueChange={next => {
              if (next === 'reading') setViewMode('reading');
              if (next === 'editing' && !editingDisabled) setViewMode('editing');
            }}
            className="flex rounded-md bg-book-bg-secondary p-0.5"
          >
            <ToggleGroupItem
              value="reading"
              className={`rounded px-2 py-1 text-2xs font-medium transition-colors ${effectiveViewMode === 'reading' ? 'bg-book-bg-card text-book-ink-primary shadow-sm' : 'text-book-ink-muted'}`}
            >
              {t.readingMode}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="editing"
              disabled={editingDisabled}
              className={`rounded px-2 py-1 text-2xs font-medium transition-colors ${effectiveViewMode === 'editing' ? 'bg-book-bg-card text-book-ink-primary shadow-sm' : 'text-book-ink-muted'} disabled:opacity-40`}
            >
              {t.editingMode}
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="w-24">
            <div className="mb-0.5 flex items-center justify-end text-xs font-semibold text-book-ink-secondary">
              <span>{progress}%</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-book-border">
              <div className="motion-essential h-full rounded-full book-progress-bar transition-progress" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </div>
      </div>

      <Sheet open={mobileChaptersOpen} onOpenChange={setMobileChaptersOpen}>
        <SheetContent aria-describedby={undefined} side="right" className="flex w-[20rem] max-w-[88vw] flex-col gap-0 border-book-border bg-book-bg-primary p-0 lg:hidden">
          <SheetHeader className="border-b border-book-border px-4 py-4 text-left">
            <SheetTitle className="text-lg font-semibold text-book-ink-primary">
              {t.manuscriptChapters}
            </SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 p-3">
            <ManuscriptSidebar
              title={title}
              genre={genre}
              storySummary={storySummary}
              characterSummary={characterSummary}
              arcSummary={arcSummary}
              progress={progress}
              chapters={sidebarChapters}
              activeChapter={effectiveActiveChapter}
              isWritingLive={editingDisabled}
              viewMode={effectiveViewMode}
              liveChapterNumber={liveChapter?.chapterNumber}
              onModeChange={setViewMode}
              onChapterSelect={(chapterNumber) => {
                setActiveChapter(chapterNumber);
                setMobileChaptersOpen(false);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* lg 布局:模型状态独占一行 — 健康态收为右对齐圆点,未绑定时
          回退的完整警告条有整行宽度,不再挤进 w-72 右栏换行(2026-06-10 审计)。
          阅读态且无法续写(已完成小说)时整行不渲染:阅读是消费,此处模型状态
          是偷正文高度的死 chrome(2026-06-25 屏幕高度审计)。 */}
      {showWritingStatus && (
        <div className="mb-2 hidden shrink-0 items-center justify-end lg:flex">
          <WritingModelDotBadge
            operation={effectiveViewMode === 'editing' ? 'polish' : 'chapter'}
            unboundDensity={effectiveViewMode === 'reading' ? 'compact' : 'strip'}
          />
        </div>
      )}

      <div className="flex-1 flex gap-6 min-h-0">
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {effectiveViewMode === 'reading' ? (
            <ManuscriptReadingView
              novelId={novelId}
              chapters={combinedChapters}
              liveChapter={liveChapter}
              mode={mode}
              activeChapter={effectiveActiveChapter}
              onActiveChapterChange={setActiveChapter}
              layout={layout}
              onLayoutChange={setLayout}
            />
          ) : (
            <ManuscriptEditingView
              ref={editingViewRef}
              novelId={novelId}
              chapter={activeChapterData}
              onChaptersChange={onChaptersChange}
              initialCreativity={initialCreativity}
              onSaveStatusChange={handleSaveStatusChange}
              hasOriginal={activeChapterData?.originalContent !== null && activeChapterData?.originalContent !== undefined}
              onDraftContentChange={handleDraftContentChange}
              draftContent={activeDraftContent}
            />
          )}
        </div>

        <div className="hidden lg:flex w-72 shrink-0 flex-col gap-2">
          {effectiveViewMode === 'editing' && saveState !== 'idle' && (
            <div className="rounded-md border border-book-border bg-book-bg-card/60 px-3 py-1.5 flex items-center">
              <SaveStatusIndicator
                state={saveState}
                lastSavedAt={lastSavedAt}
                onRetry={handleSaveRetry}
              />
            </div>
          )}
          <ManuscriptSidebar
            title={title}
            genre={genre}
            storySummary={storySummary}
            characterSummary={characterSummary}
            arcSummary={arcSummary}
            progress={progress}
            chapters={sidebarChapters}
            activeChapter={effectiveActiveChapter}
            isWritingLive={editingDisabled}
            viewMode={effectiveViewMode}
            liveChapterNumber={liveChapter?.chapterNumber}
            onModeChange={setViewMode}
            onChapterSelect={setActiveChapter}
          />
        </div>
      </div>
    </div>
  );
}
