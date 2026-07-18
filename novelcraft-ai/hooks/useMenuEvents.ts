'use client';

import { useEffect, useRef } from 'react';

import { isTauriRuntime } from '@/lib/desktop-runtime';

export function useMenuEvents(handler: (id: string) => void): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const off = await listen<string>('inkmarshal://menu', e => {
          if (typeof e.payload === 'string') handlerRef.current(e.payload);
        });
        if (cancelled) {
          off();
        } else {
          unlisten = off;
        }
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('useMenuEvents: failed to subscribe', err);
        }
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
