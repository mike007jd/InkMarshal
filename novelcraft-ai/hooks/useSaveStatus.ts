'use client';

import { useCallback, useRef, useState } from 'react';
import type { SaveState } from '@/components/SaveStatusIndicator';

/**
 * Tiny state machine that ManuscriptEditingView wraps around its
 * `persistChapter()` flow. Three transitions are exposed:
 *   - `markSaving()`     — call right before fetch
 *   - `markSaved(at)`    — call after a 200 OK
 *   - `markFailed()`     — call on network/server/version conflict (when the
 *                          chapter cannot be re-fetched safely)
 *
 * The hook also surfaces `subscribe(cb)`-style callback wiring so a parent
 * shell (ManuscriptShell) can render a SaveStatusIndicator without lifting
 * persistChapter state up.
 */
export function useSaveStatus(initialState: SaveState = 'idle') {
  const [state, setState] = useState<SaveState>(initialState);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // Persist the latest "failed" retry callback so the indicator's retry
  // button can re-fire the exact failed flush even after re-renders.
  const retryRef = useRef<(() => void) | null>(null);

  const markSaving = useCallback(() => {
    setState('saving');
  }, []);

  const markSaved = useCallback((at: number = Date.now()) => {
    setState('saved');
    setLastSavedAt(at);
    retryRef.current = null;
  }, []);

  const markFailed = useCallback((retry?: () => void) => {
    setState('failed');
    retryRef.current = retry ?? null;
  }, []);

  /** Reset to idle (e.g. on chapter switch). Clears retry handle too. */
  const reset = useCallback(() => {
    setState('idle');
    retryRef.current = null;
  }, []);

  const triggerRetry = useCallback(() => {
    const fn = retryRef.current;
    if (fn) fn();
  }, []);

  return {
    state,
    lastSavedAt,
    markSaving,
    markSaved,
    markFailed,
    reset,
    triggerRetry,
  } as const;
}
