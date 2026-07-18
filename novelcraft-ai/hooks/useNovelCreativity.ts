'use client';

// Per-novel creativity state with localStorage cache + debounced server
// persistence. Owned by the writing surface; both ManuscriptEditingView and
// EditChatbox/ChatArea consume the same hook so toggling the level in either
// place stays in sync within the tab (sessionStorage event isn't needed —
// React state is the single source of truth for the active mount; localStorage
// only saves a fast first-paint on the next visit so the SSR boundary doesn't
// flash the default).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OPERATION_DEFAULT_CREATIVITY,
  isCreativityLevel,
  type CreativityLevel,
} from '@/lib/ai/generation-presets';
import type { NovelSettings } from '@/lib/db-types';

const PERSIST_DEBOUNCE_MS = 500;

// Default the writing surface to its polish-class default — that's the
// per-chapter editor's primary action, and conservative is the right
// starting energy for a draft you're already polishing.
const SURFACE_DEFAULT: CreativityLevel = OPERATION_DEFAULT_CREATIVITY.polish;

function storageKey(novelId: string): string {
  return `creativity:${novelId}`;
}

async function persistCreativitySetting(
  novelId: string,
  value: CreativityLevel,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/novels/${novelId}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creativity: value }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Failed to persist creativity setting (HTTP ${res.status})`);
  }
}

export function readCachedNovelCreativity(novelId: string): CreativityLevel | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(novelId));
    return isCreativityLevel(raw) ? raw : null;
  } catch {
    return null;
  }
}

export interface UseNovelCreativityResult {
  /** Currently active creativity level. */
  creativity: CreativityLevel;
  /** Set + persist. Optimistic — local state updates immediately. */
  setCreativity: (next: CreativityLevel) => void;
  /** True when the latest server sync failed; local selection remains active. */
  syncFailed: boolean;
}

/**
 * Read/write per-novel creativity, with a debounced PATCH to
 * `/api/novels/[id]/settings`. `initialServerValue` is whatever the novel
 * record already carries (so a freshly-opened chapter doesn't flash the
 * surface default before the server value lands).
 */
export function useNovelCreativity(
  novelId: string,
  initialServerValue?: CreativityLevel | null,
): UseNovelCreativityResult {
  const [creativity, setLocal] = useState<CreativityLevel>(() => {
    // Resolution order: server value (passed in) → localStorage → surface
    // default. localStorage is the SSR-safe "remember my last pick across
    // tabs" cache; first render uses the server value passed by the parent
    // because window isn't available yet.
    if (initialServerValue && isCreativityLevel(initialServerValue)) {
      return initialServerValue;
    }
    return SURFACE_DEFAULT;
  });
  const [syncFailed, setSyncFailed] = useState(false);
  const latestCreativity = useRef<CreativityLevel>(creativity);

  // After mount/novel switch, sync to the active novel's canonical value.
  // Don't rely on the useState initializer here: ManuscriptShell can swap
  // novels without remounting this hook.
  useEffect(() => {
    const hasServerValue = initialServerValue && isCreativityLevel(initialServerValue);
    const next = hasServerValue
      ? initialServerValue
      : readCachedNovelCreativity(novelId) ?? SURFACE_DEFAULT;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        if (hasServerValue) {
          try { window.localStorage.setItem(storageKey(novelId), next); } catch { /* quota */ }
        }
        latestCreativity.current = next;
        setLocal(next);
        setSyncFailed(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [novelId, initialServerValue]);

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const flushToServer = useCallback(async (value: CreativityLevel) => {
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    try {
      await persistCreativitySetting(novelId, value, ctrl.signal);
      setSyncFailed(false);
    } catch (error) {
      if (ctrl.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      setSyncFailed(true);
    } finally {
      if (inFlight.current === ctrl) inFlight.current = null;
    }
  }, [novelId]);

  const setCreativity = useCallback((next: CreativityLevel) => {
    latestCreativity.current = next;
    setLocal(next);
    setSyncFailed(false);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(storageKey(novelId), next); } catch { /* quota */ }
    }
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      void flushToServer(next);
    }, PERSIST_DEBOUNCE_MS);
  }, [flushToServer, novelId]);

  // Flush on unmount / novel switch so a quick tab-switch after toggling doesn't
  // lose the last value. Keep this independent of `creativity`: running cleanup
  // on every creativity change would cancel the new debounce and PATCH the old
  // value back to the server.
  useEffect(() => {
    return () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
        void persistCreativitySetting(novelId, latestCreativity.current).catch(() => {});
      }
    };
  }, [novelId]);

  return { creativity, setCreativity, syncFailed };
}

/** Convenience: derive the picker's initial server value off a Novel record. */
export function creativityFromSettings(settings: NovelSettings | null | undefined): CreativityLevel | null {
  if (!settings) return null;
  return isCreativityLevel(settings.creativity) ? settings.creativity : null;
}
