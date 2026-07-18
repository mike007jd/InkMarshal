'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  searchManuscriptSync,
  type SearchInputChapter,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from './manuscript-search';

interface PendingSearch {
  chapters: SearchInputChapter[];
  query: string;
  resolve: (r: SearchResult[]) => void;
}

/**
 * `useManuscriptSearch` lazily spins up a single Web Worker for the lifetime
 * of the consumer (the search dialog) and returns a debounce-friendly
 * `search(query)` that resolves with results.
 *
 * If the Worker can't be created (SSR pre-hydrate, a sandbox without Worker
 * support, or if the bundler-injected URL throws), every call falls back to
 * synchronous `searchManuscriptSync` so the UI still works — just on the main
 * thread.
 */
export function useManuscriptSearch() {
  const workerRef = useRef<Worker | null>(null);
  const seqRef = useRef(0);
  const pendingRef = useRef<Map<number, PendingSearch>>(new Map());

  useEffect(() => {
    // Snapshot the pending map for use during the cleanup. The map identity
    // never changes (useRef gives a stable wrapper), so capturing it once is
    // safe and silences react-hooks/exhaustive-deps's stale-ref warning.
    const pending = pendingRef.current;
    if (typeof window === 'undefined' || typeof Worker === 'undefined') return;
    try {
      const worker = new Worker(
        new URL('./manuscript-search.worker.ts', import.meta.url),
        { type: 'module' },
      );
      worker.addEventListener('message', (event: MessageEvent<SearchResponse>) => {
        const pendingSearch = pending.get(event.data.id);
        if (pendingSearch) {
          pending.delete(event.data.id);
          pendingSearch.resolve(event.data.results);
        }
      });
      const settlePendingWithSyncFallback = () => {
        for (const [id, item] of pending) {
          pending.delete(id);
          item.resolve(searchManuscriptSync(item.chapters, item.query));
        }
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      };
      worker.addEventListener('error', settlePendingWithSyncFallback);
      worker.addEventListener('messageerror', settlePendingWithSyncFallback);
      workerRef.current = worker;
    } catch {
      workerRef.current = null;
    }
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      for (const [id, item] of pending) {
        pending.delete(id);
        item.resolve([]);
      }
    };
  }, []);

  const search = useCallback(
    async (chapters: SearchInputChapter[], query: string): Promise<SearchResult[]> => {
      const worker = workerRef.current;
      if (!worker) {
        return searchManuscriptSync(chapters, query);
      }
      const id = ++seqRef.current;
      return new Promise<SearchResult[]>(resolve => {
        pendingRef.current.set(id, { chapters, query, resolve });
        const req: SearchRequest = { id, chapters, query };
        try {
          worker.postMessage(req);
        } catch {
          pendingRef.current.delete(id);
          resolve(searchManuscriptSync(chapters, query));
        }
      });
    },
    [],
  );

  return { search };
}
