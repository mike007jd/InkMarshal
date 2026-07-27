'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

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

export function useNovelWorkspaceNavigation(
  novelId: string,
  initialView: NovelView,
) {
  const searchParams = useSearchParams();
  const viewFromUrl = useMemo(
    () => parseViewParam(searchParams?.get('view') ?? null),
    [searchParams],
  );
  const [view, setView] = useState<NovelView>(() => viewFromUrl ?? initialView);

  const selectView = useCallback((nextView: NovelView) => {
    setView(nextView);
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
      if (!cancelled) setView(current => current === viewFromUrl ? current : viewFromUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [viewFromUrl]);

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
