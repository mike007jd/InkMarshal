'use client';

import { useMemo, useSyncExternalStore } from 'react';

import {
  getStoredSetting,
  onAppSettingsHydrated,
  setStoredSetting,
} from '@/lib/app-settings-client';
import { isTauriRuntime } from '@/lib/desktop-runtime';
import type { NovelView } from '@/lib/novel-workspace-view';

const WORKSPACE_VIEWS_KEY = 'inkmarshal_workspace_views_v1';
const CANONICAL_WORKSPACE_VIEWS: ReadonlySet<string> = new Set([
  'agent',
  'story-deck',
  'read-edit',
]);
const listeners = new Set<() => void>();

function readRawWorkspaceViews(): string {
  return getStoredSetting(WORKSPACE_VIEWS_KEY) ?? '';
}

function emitWorkspaceViewsChanged(): void {
  for (const listener of Array.from(listeners)) listener();
}

/** Parse and canonicalize the durable novel-id → workspace-mode map. */
export function parseNovelWorkspaceViews(
  raw: string | null | undefined,
): Record<string, NovelView> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const views: Record<string, NovelView> = {};
    for (const [novelId, candidate] of Object.entries(parsed)) {
      if (typeof candidate !== 'string') continue;
      if (CANONICAL_WORKSPACE_VIEWS.has(candidate)) {
        views[novelId] = candidate as NovelView;
      }
    }
    return views;
  } catch {
    return {};
  }
}

export function readRememberedNovelWorkspaceView(novelId: string): NovelView | null {
  return parseNovelWorkspaceViews(readRawWorkspaceViews())[novelId] ?? null;
}

export function rememberNovelWorkspaceView(novelId: string, view: NovelView): void {
  const views = parseNovelWorkspaceViews(readRawWorkspaceViews());
  if (views[novelId] === view) return;
  views[novelId] = view;
  setStoredSetting(WORKSPACE_VIEWS_KEY, JSON.stringify(views));
  emitWorkspaceViewsChanged();
}

/**
 * Initial route state must not overwrite SQLite before desktop hydration has
 * exposed the authoritative value. Explicit user tab changes still use the
 * immediate writer above.
 */
export function rememberNovelWorkspaceViewAfterHydration(
  novelId: string,
  view: NovelView,
): () => void {
  if (!isTauriRuntime()) {
    rememberNovelWorkspaceView(novelId, view);
    return () => {};
  }
  return onAppSettingsHydrated(() => rememberNovelWorkspaceView(novelId, view));
}

export function subscribeNovelWorkspaceViews(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribeHydration = onAppSettingsHydrated(listener);
  return () => {
    listeners.delete(listener);
    unsubscribeHydration();
  };
}

/** React view of the SQLite-backed preferences, refreshed after desktop hydration. */
export function useRememberedNovelViews(): Readonly<Record<string, NovelView>> {
  const raw = useSyncExternalStore(
    subscribeNovelWorkspaceViews,
    readRawWorkspaceViews,
    () => '',
  );
  return useMemo(() => parseNovelWorkspaceViews(raw), [raw]);
}
