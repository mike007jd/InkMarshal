'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { requestManuscriptFlush } from '@/lib/desktop-shell-bus';
import {
  buildNovelViewHref,
  parseViewParam,
  type NovelView,
} from '@/lib/novel-workspace-view';
import {
  rememberNovelWorkspaceView,
  rememberNovelWorkspaceViewAfterHydration,
} from '@/lib/novel-workspace-preferences';

function positiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function leavesReadEdit(from: NovelView, to: NovelView): boolean {
  return from === 'read-edit' && to !== 'read-edit';
}

export function useNovelWorkspaceNavigation(
  novelId: string,
  initialView: NovelView,
) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const viewFromUrl = useMemo(
    () => parseViewParam(searchParams?.get('view') ?? null),
    [searchParams],
  );
  const [view, setView] = useState<NovelView>(() => viewFromUrl ?? initialView);
  const viewRef = useRef(view);
  const selectSeqRef = useRef(0);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const applyView = useCallback((nextView: NovelView) => {
    setView(nextView);
    viewRef.current = nextView;
    rememberNovelWorkspaceView(novelId, nextView);
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const nextHref = buildNovelViewHref(
      window.location.pathname,
      window.location.search,
      nextView,
      window.location.hash,
    );
    if (nextHref !== currentHref) window.history.replaceState(null, '', nextHref);
  }, [novelId]);

  const selectView = useCallback((nextView: NovelView) => {
    const seq = ++selectSeqRef.current;
    const fromView = viewRef.current;
    if (nextView === fromView) return;

    // Entry into read-edit (and agent ↔ story) stays synchronous. Only leaving
    // the manuscript needs an awaited flush before unmount.
    if (!leavesReadEdit(fromView, nextView)) {
      applyView(nextView);
      return;
    }

    void (async () => {
      // Flush while ManuscriptShell/editor listeners are still mounted.
      const outcome = await requestManuscriptFlush();
      if (selectSeqRef.current !== seq) return;
      if (!outcome.ok) {
        toast(t.editorSaveError, 'error');
        return;
      }
      // Another selector won, or an external sync moved us already.
      if (viewRef.current !== fromView) return;
      if (selectSeqRef.current !== seq) return;
      applyView(nextView);
    })();
  }, [applyView, t.editorSaveError, toast]);

  useEffect(() => {
    return rememberNovelWorkspaceViewAfterHydration(
      novelId,
      viewFromUrl ?? initialView,
    );
  }, [initialView, novelId, viewFromUrl]);

  useEffect(() => {
    if (!viewFromUrl) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) selectView(viewFromUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [selectView, viewFromUrl]);

  useEffect(() => {
    const handler = (event: Event) => {
      const next = (event as CustomEvent<{ view?: string }>).detail?.view;
      const parsed = parseViewParam(next);
      if (parsed) selectView(parsed);
    };
    window.addEventListener('inkmarshal://menu', handler);
    return () => window.removeEventListener('inkmarshal://menu', handler);
  }, [selectView]);

  return {
    view,
    selectView,
    chapterFromUrl: positiveInteger(searchParams?.get('chapter') ?? null),
    startInEditing: searchParams?.get('edit') === '1',
    searchOffsetFromUrl: nonNegativeInteger(searchParams?.get('offset') ?? null),
    autostart: searchParams?.get('autostart') === '1',
  };
}
