'use client';

// Per-novel style-reference selection. The picker is a UI control; the
// selection is purely client-side (localStorage keyed by novelId). The
// server doesn't need to persist it — it only needs the styleId on the
// incoming request header to inject the right style entry into the prompt.

import { useCallback, useEffect, useState } from 'react';
import { normalizeStyleId } from '@/lib/style-id';

function storageKey(novelId: string): string {
  return `style-id:${novelId}`;
}

function readCached(novelId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(novelId));
    const normalized = normalizeStyleId(raw);
    if (!normalized && raw) window.localStorage.removeItem(storageKey(novelId));
    return normalized;
  } catch {
    return null;
  }
}

export interface UseNovelStyleResult {
  styleId: string | null;
  setStyleId: (next: string | null) => void;
}

export function useNovelStyle(novelId: string): UseNovelStyleResult {
  const [styleId, setLocal] = useState<string | null>(null);

  // Read the cached value after mount (avoid SSR hydration mismatch).
  useEffect(() => {
    const cached = readCached(novelId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- canonical "load persisted state after hydration" pattern; running on the server would mismatch.
    setLocal(cached);
  }, [novelId]);

  const setStyleId = useCallback((next: string | null) => {
    const normalized = normalizeStyleId(next);
    setLocal(normalized);
    if (typeof window === 'undefined') return;
    try {
      if (normalized) {
        window.localStorage.setItem(storageKey(novelId), normalized);
      } else {
        window.localStorage.removeItem(storageKey(novelId));
      }
    } catch {
      // localStorage full / private mode — UI state still works.
    }
  }, [novelId]);

  return { styleId, setStyleId };
}
