'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Novel } from '@/lib/db-types';
import type { CreateNovelRequest } from '@/lib/types/novel';
import { getExampleById } from '@/lib/examples';
import { isExampleNovelId } from '@/lib/examples/prefix';

/** Stable local-database failure codes returned by authenticated desktop novel APIs. */
export type LocalDatabaseIssueCode =
  | 'DATABASE_BACKUP_REQUIRED'
  | 'DATABASE_INCOMPATIBLE'
  | 'DATABASE_NEWER_VERSION'
  | 'DATABASE_UNAVAILABLE';

const LOCAL_DATABASE_ISSUE_CODES = new Set<LocalDatabaseIssueCode>([
  'DATABASE_BACKUP_REQUIRED',
  'DATABASE_INCOMPATIBLE',
  'DATABASE_NEWER_VERSION',
  'DATABASE_UNAVAILABLE',
]);

function parseLocalDatabaseIssue(payload: unknown): LocalDatabaseIssueCode | null {
  if (!payload || typeof payload !== 'object') return null;
  const code = (payload as { code?: unknown }).code;
  if (typeof code !== 'string') return null;
  return LOCAL_DATABASE_ISSUE_CODES.has(code as LocalDatabaseIssueCode)
    ? (code as LocalDatabaseIssueCode)
    : null;
}

export type CreateNovelResult = {
  novel: Novel | null;
  databaseIssue: LocalDatabaseIssueCode | null;
};

/** Localized actionable copy for a typed local-database failure code. */
export function localDatabaseIssueCopy(
  t: {
    databaseBackupRequiredTitle: string;
    databaseBackupRequiredBody: string;
    databaseIncompatibleTitle: string;
    databaseIncompatibleBody: string;
    databaseNewerVersionTitle: string;
    databaseNewerVersionBody: string;
    databaseUnavailableTitle: string;
    databaseUnavailableBody: string;
  },
  code: LocalDatabaseIssueCode,
): { title: string; body: string } {
  if (code === 'DATABASE_BACKUP_REQUIRED') {
    return { title: t.databaseBackupRequiredTitle, body: t.databaseBackupRequiredBody };
  }
  if (code === 'DATABASE_NEWER_VERSION') {
    return { title: t.databaseNewerVersionTitle, body: t.databaseNewerVersionBody };
  }
  if (code === 'DATABASE_UNAVAILABLE') {
    return { title: t.databaseUnavailableTitle, body: t.databaseUnavailableBody };
  }
  return { title: t.databaseIncompatibleTitle, body: t.databaseIncompatibleBody };
}

/** Same-document fan-out after a successful novel PATCH so list subscribers converge. */
export const NOVEL_UPDATED_EVENT = 'inkmarshal:novel-updated';

export interface NovelUpdatedEventDetail {
  novel: Novel;
}

export function notifyNovelUpdated(novel: Novel): void {
  if (typeof window === 'undefined' || !novel?.id) return;
  window.dispatchEvent(
    new CustomEvent<NovelUpdatedEventDetail>(NOVEL_UPDATED_EVENT, {
      detail: { novel },
    }),
  );
}

function applyNovelUpdatedToList(
  novels: Novel[],
  updated: Novel,
): Novel[] {
  const index = novels.findIndex(novel => novel.id === updated.id);
  if (index < 0) return novels;
  const next = novels.slice();
  next[index] = updated;
  return next.sort((left, right) => right.updatedAt - left.updatedAt);
}

// No-account local-first app: every session is the single local user, and local
// workspace storage is always available with no account-resolution delay.
export function useStorageMode() {
  return { storageReady: true, canUseLocalWorkspace: true };
}

export function useNovels() {
  const [novels, setNovels] = useState<Novel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [databaseIssue, setDatabaseIssue] = useState<LocalDatabaseIssueCode | null>(null);
  const refreshSeqRef = useRef(0);
  const updateVersionRef = useRef(0);
  const pendingUpdatesRef = useRef(
    new Map<string, { novel: Novel; version: number }>(),
  );

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const updateVersionAtStart = updateVersionRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/novels');
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const issue = parseLocalDatabaseIssue(payload);
        if (refreshSeqRef.current !== seq) return;
        setDatabaseIssue(issue);
        throw new Error(
          issue
            ? `GET /api/novels ${res.status} ${issue}`
            : `GET /api/novels ${res.status}`,
        );
      }
      const fetched = await res.json() as Novel[];
      if (refreshSeqRef.current !== seq) return;
      setDatabaseIssue(null);
      let merged = fetched;
      for (const pending of pendingUpdatesRef.current.values()) {
        // Only events that arrived after this GET began can be newer than its
        // snapshot. Earlier events are already reflected by the authoritative
        // response and must not overwrite newer fields such as progress.
        if (pending.version > updateVersionAtStart) {
          merged = applyNovelUpdatedToList(merged, pending.novel);
        }
      }
      setNovels(merged);
      // A GET that began after an update event is authoritative for that
      // update. Older GETs merge the pending update but retain it so the next
      // post-event read also cannot roll the title back.
      for (const [id, pending] of pendingUpdatesRef.current) {
        if (pending.version <= updateVersionAtStart) {
          pendingUpdatesRef.current.delete(id);
        }
      }
    } catch (err) {
      if (refreshSeqRef.current !== seq) return;
      console.error('[useNovels] refresh failed:', err);
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (refreshSeqRef.current === seq) setLoading(false);
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

  useEffect(() => {
    const onNovelUpdated = (event: Event) => {
      const novel = (event as CustomEvent<NovelUpdatedEventDetail>).detail?.novel;
      if (!novel?.id) return;
      const version = ++updateVersionRef.current;
      pendingUpdatesRef.current.set(novel.id, { novel, version });
      setNovels(current => applyNovelUpdatedToList(current, novel));
    };
    window.addEventListener(NOVEL_UPDATED_EVENT, onNovelUpdated);
    return () => window.removeEventListener(NOVEL_UPDATED_EVENT, onNovelUpdated);
  }, []);
  const create = useCallback(
    async (data: CreateNovelRequest = {}): Promise<CreateNovelResult> => {
      let databaseIssue: LocalDatabaseIssueCode | null = null;
      try {
        const res = await fetch('/api/novels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          databaseIssue = parseLocalDatabaseIssue(payload);
          if (databaseIssue) setDatabaseIssue(databaseIssue);
          throw new Error(
            databaseIssue
              ? `POST /api/novels ${res.status} ${databaseIssue}`
              : `POST /api/novels ${res.status}`,
          );
        }
        const novel: Novel = await res.json();
        setDatabaseIssue(null);
        await refresh();
        return { novel, databaseIssue: null };
      } catch (err) {
        console.error('[useNovels] create failed:', err);
        return { novel: null, databaseIssue };
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

  return { novels, loading, error, databaseIssue, refresh, create, remove };
}

export function useNovel(novelId: string | undefined) {
  const [novel, setNovel] = useState<Novel | null>(null);
  const [loading, setLoading] = useState(true);
  const activeNovelIdRef = useRef(novelId);
  const refreshSeqRef = useRef(0);
  const updateSeqByNovelRef = useRef(new Map<string, number>());

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
      const seq = (updateSeqByNovelRef.current.get(requestNovelId) ?? 0) + 1;
      updateSeqByNovelRef.current.set(requestNovelId, seq);
      const isLatestForNovel = () =>
        updateSeqByNovelRef.current.get(requestNovelId) === seq;
      try {
        const res = await fetch(`/api/novels/${requestNovelId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error(`PATCH /api/novels/${requestNovelId} ${res.status}`);
        const updated: Novel = await res.json();
        if (activeNovelIdRef.current === requestNovelId && isLatestForNovel()) {
          // A refresh captured before this successful mutation is stale even
          // when it resolves afterwards. Invalidate that independent read
          // sequence before publishing the canonical PATCH response.
          refreshSeqRef.current += 1;
          setNovel(updated);
        }
        // A slower superseded PATCH response must not roll list subscribers
        // back after a newer update has already converged them.
        if (isLatestForNovel()) notifyNovelUpdated(updated);
        return updated;
      } catch (err) {
        if (activeNovelIdRef.current === requestNovelId && isLatestForNovel()) {
          console.error('[useNovel] update failed:', err);
        }
        return null;
      }
    },
    [novelId],
  );

  return { novel, loading, refresh, update };
}
