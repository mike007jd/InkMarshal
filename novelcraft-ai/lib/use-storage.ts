'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Novel } from '@/lib/db-types';
import type { CreateNovelRequest } from '@/lib/types/novel';
import { getExampleById } from '@/lib/examples';
import { isExampleNovelId } from '@/lib/examples/prefix';

// No-account local-first app: every session is the single local user, and local
// workspace storage is always available with no account-resolution delay.
export function useStorageMode() {
  return { storageReady: true, canUseLocalWorkspace: true };
}

export function useNovels() {
  const [novels, setNovels] = useState<Novel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/novels');
      if (!res.ok) throw new Error(`GET /api/novels ${res.status}`);
      setNovels(await res.json());
    } catch (err) {
      console.error('[useNovels] refresh failed:', err);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const create = useCallback(
    async (data: CreateNovelRequest = {}): Promise<Novel | null> => {
      try {
        const res = await fetch('/api/novels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`POST /api/novels ${res.status}`);
        const novel: Novel = await res.json();
        await refresh();
        return novel;
      } catch (err) {
        console.error('[useNovels] create failed:', err);
        return null;
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await fetch(`/api/novels/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`DELETE /api/novels ${res.status}`);
        await refresh();
        return true;
      } catch (err) {
        console.error('[useNovels] remove failed:', err);
        return false;
      }
    },
    [refresh],
  );

  return { novels, loading, error, refresh, create, remove };
}

export function useNovel(novelId: string | undefined) {
  const [novel, setNovel] = useState<Novel | null>(null);
  const [loading, setLoading] = useState(true);
  const activeNovelIdRef = useRef(novelId);
  const refreshSeqRef = useRef(0);
  const updateSeqRef = useRef(0);

  useEffect(() => {
    activeNovelIdRef.current = novelId;
  }, [novelId]);

  const refresh = useCallback(async () => {
    const requestNovelId = novelId;
    const seq = ++refreshSeqRef.current;
    const isCurrent = () =>
      activeNovelIdRef.current === requestNovelId && refreshSeqRef.current === seq;
    if (!requestNovelId) {
      setNovel(null);
      setLoading(false);
      return;
    }
    if (isExampleNovelId(requestNovelId)) {
      setNovel(getExampleById(requestNovelId)?.novel ?? null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/novels/${requestNovelId}`);
      if (!res.ok) throw new Error(`GET /api/novels/${requestNovelId} ${res.status}`);
      const data: Novel = await res.json();
      if (isCurrent()) setNovel(data);
    } catch (err) {
      if (isCurrent()) console.error('[useNovel] refresh failed:', err);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const update = useCallback(
    async (data: Partial<Novel>): Promise<Novel | null> => {
      if (!novelId) return null;
      const requestNovelId = novelId;
      const seq = ++updateSeqRef.current;
      try {
        const res = await fetch(`/api/novels/${requestNovelId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`PATCH /api/novels/${requestNovelId} ${res.status}`);
        const updated: Novel = await res.json();
        if (activeNovelIdRef.current === requestNovelId && updateSeqRef.current === seq) {
          setNovel(updated);
        }
        return updated;
      } catch (err) {
        if (activeNovelIdRef.current === requestNovelId && updateSeqRef.current === seq) {
          console.error('[useNovel] update failed:', err);
        }
        return null;
      }
    },
    [novelId],
  );

  return { novel, loading, refresh, update };
}
