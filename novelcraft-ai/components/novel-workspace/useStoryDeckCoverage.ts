'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  EMPTY_DECK_COUNTS,
  type DeckCounts,
} from '@/components/novel-workspace/types';

export function useStoryDeckCoverage(novelId: string) {
  const [panelRefreshToken, setPanelRefreshToken] = useState(0);
  const [coverageRefreshToken, setCoverageRefreshToken] = useState(0);
  const [counts, setCounts] = useState<DeckCounts>(EMPTY_DECK_COUNTS);
  const [countsNovelId, setCountsNovelId] = useState(novelId);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(`/api/novels/${novelId}/knowledge`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Failed to load Story Deck (HTTP ${response.status})`);
        }
        const entries = await response.json() as Array<{ type?: string }>;
        const next: DeckCounts = { ...EMPTY_DECK_COUNTS };
        for (const entry of entries) {
          if (entry.type === 'character' || entry.type === 'world' || entry.type === 'outline') {
            next[entry.type] += 1;
          }
        }
        if (!controller.signal.aborted) {
          setCounts(next);
          setCountsNovelId(novelId);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          console.error('Failed to refresh Story Deck coverage:', error);
          setCounts(EMPTY_DECK_COUNTS);
          setCountsNovelId(novelId);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [coverageRefreshToken, novelId]);

  const refreshCoverage = useCallback(() => {
    setCoverageRefreshToken(current => current + 1);
  }, []);

  const refreshAll = useCallback(() => {
    setPanelRefreshToken(current => current + 1);
    setCoverageRefreshToken(current => current + 1);
  }, []);

  const activeCounts = countsNovelId === novelId ? counts : EMPTY_DECK_COUNTS;

  return {
    counts: activeCounts,
    complete: activeCounts.character > 0
      && activeCounts.world > 0
      && activeCounts.outline > 0,
    loading: loading || countsNovelId !== novelId,
    panelRefreshToken,
    refreshCoverage,
    refreshAll,
  };
}
