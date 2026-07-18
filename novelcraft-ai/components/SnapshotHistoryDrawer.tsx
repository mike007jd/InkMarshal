'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { History, Plus, RotateCcw } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ChapterSnapshot } from '@/lib/db-types';

interface SnapshotHistoryDrawerProps {
  novelId: string;
  chapterNumber: number;
  chapterVersion: number;
  /** Fires after a successful snapshot restore so the parent can refetch
   *  chapter content. */
  onRestored?: () => void;
  /** Flush unsaved editor content before snapshot create/restore. */
  onBeforeAction?: () => Promise<boolean>;
}

/** Window during which the toast "Undo restore" link is valid. After this the
 *  pre-restore content is dropped from memory (the server's `(before restore)`
 *  safety snapshot remains as a slower fallback). */
const UNDO_WINDOW_MS = 8000;

function formatRelative(ts: number, locale: string): string {
  if (ts <= 0) return '';
  const d = new Date(ts);
  return d.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Toolbar icon that opens a popover listing manual snapshots of the current
 *  chapter. Users can take a new snapshot (label optional) or restore an
 *  existing one. Capped at 10 entries by the server. */
export function SnapshotHistoryDrawer({
  novelId,
  chapterNumber,
  chapterVersion,
  onRestored,
  onBeforeAction,
}: SnapshotHistoryDrawerProps) {
  const { t, language } = useLanguage();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<ChapterSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const activeScopeRef = useRef(`${novelId}:${chapterNumber}`);
  // Pre-restore content stashed for the 8s "Undo restore" toast action, kept in
  // a ref so the toast closure always sees the latest value.
  const undoStashRef = useRef<{ content: string; version: number | undefined; expiresAt: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    activeScopeRef.current = `${novelId}:${chapterNumber}`;
    queueMicrotask(() => {
      if (cancelled) return;
      setSnapshots([]);
      setLoading(false);
      setCreating(false);
      setRestoringId(null);
      setLabel('');
    });
    return () => {
      cancelled = true;
    };
  }, [novelId, chapterNumber]);

  const refresh = useCallback(async () => {
    const requestScope = `${novelId}:${chapterNumber}`;
    setLoading(true);
    try {
      const r = await fetch(`/api/novels/${novelId}/chapters/${chapterNumber}/snapshots`);
      if (!r.ok) throw new Error('list failed');
      const data = (await r.json()) as { snapshots?: ChapterSnapshot[] };
      if (activeScopeRef.current === requestScope) {
        setSnapshots(Array.isArray(data.snapshots) ? data.snapshots : []);
      }
    } catch {
      if (activeScopeRef.current === requestScope) setSnapshots([]);
    } finally {
      if (activeScopeRef.current === requestScope) setLoading(false);
    }
  }, [novelId, chapterNumber]);

  // Refetch when the drawer is opened (cheap; only one chapter at a time).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [open, refresh]);

  async function handleCreate() {
    const requestScope = `${novelId}:${chapterNumber}`;
    setCreating(true);
    try {
      if (onBeforeAction && !(await onBeforeAction())) return;
      const r = await fetch(`/api/novels/${novelId}/chapters/${chapterNumber}/snapshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label || undefined }),
      });
      if (!r.ok) throw new Error('create failed');
      if (activeScopeRef.current !== requestScope) return;
      setLabel('');
      await refresh();
    } catch {
      if (activeScopeRef.current === requestScope) {
        toast(t.snapshotCreateFailed, 'error', {
          action: { label: t.toastRetry, onClick: () => handleCreate() },
        });
      }
    } finally {
      if (activeScopeRef.current === requestScope) setCreating(false);
    }
  }

  async function handleRestore(snapshotId: string) {
    const requestScope = `${novelId}:${chapterNumber}`;
    setRestoringId(snapshotId);
    try {
      if (onBeforeAction && !(await onBeforeAction())) return;

      // Stash the content that's current right before the restore overwrites it,
      // so we can offer a one-click "Undo restore" (best-effort; if we can't read
      // it, undo just isn't offered — the server's `(before restore)` snapshot
      // still exists as a fallback).
      let preRestoreContent: string | null = null;
      try {
        const cur = await fetch(`/api/novels/${novelId}/chapters`);
        if (cur.ok) {
          const data = await cur.json();
          const list: Array<{ chapterNumber: number; content: string }> = Array.isArray(data?.chapters)
            ? data.chapters
            : Array.isArray(data)
              ? data
              : [];
          const hit = list.find(c => c.chapterNumber === chapterNumber);
          if (hit) preRestoreContent = hit.content;
        }
      } catch {
        // Best-effort stash.
      }

      const r = await fetch(
        `/api/novels/${novelId}/chapters/${chapterNumber}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: chapterVersion }),
        },
      );
      if (!r.ok) throw new Error('restore failed');
      if (activeScopeRef.current !== requestScope) return;
      const restored = (await r.json().catch(() => ({}))) as { version?: unknown };
      const undoVersion = typeof restored.version === 'number' ? restored.version : undefined;
      onRestored?.();
      setOpen(false);

      const undoAction = preRestoreContent !== null
        ? {
            label: t.snapshotRestoreUndo,
            onClick: () => {
              const stash = undoStashRef.current;
              if (!stash || Date.now() > stash.expiresAt) return;
              fetch(`/api/novels/${novelId}/chapters/${chapterNumber}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: stash.content, version: stash.version }),
              }).then(res => {
                if (res.ok) onRestored?.();
              }).catch(() => {});
              undoStashRef.current = null;
            },
          }
        : undefined;
      if (preRestoreContent !== null) {
        undoStashRef.current = { content: preRestoreContent, version: undoVersion, expiresAt: Date.now() + UNDO_WINDOW_MS };
      }
      toast(t.snapshotRestoreSuccess, 'success', { action: undoAction, durationMs: UNDO_WINDOW_MS });
    } catch {
      if (activeScopeRef.current === requestScope) {
        toast(t.snapshotRestoreFailed, 'error', {
          action: { label: t.toastRetry, onClick: () => handleRestore(snapshotId) },
        });
      }
    } finally {
      if (activeScopeRef.current === requestScope) setRestoringId(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          size="sm"
          className="h-7 px-2 text-xs gap-1 text-book-ink-secondary hover:text-book-ink-primary"
          title={t.snapshotsTitle}
        >
          <History className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t.snapshotsTitle}</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80 border-book-border p-3 shadow-card">
        <PopoverHeader className="mb-2">
          <PopoverTitle className="text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
            {t.snapshotsTitle}
          </PopoverTitle>
        </PopoverHeader>

        <div className="flex gap-2 mb-3">
          <Input
            variant="boxed"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t.snapshotLabelPlaceholder}
            maxLength={80}
            className="flex-1 text-xs"
          />
          <Button
            variant="book"
            type="button"
            size="sm"
            onClick={handleCreate}
            disabled={creating}
            className="h-8 px-2 text-xs gap-1"
          >
            <Plus className="w-3 h-3" />
            {t.snapshotCreate}
          </Button>
        </div>

        <ScrollArea className="-mx-1 h-fit max-h-72 px-1">
          {loading ? (
            <div className="py-4 text-center text-xs text-book-ink-muted">…</div>
          ) : snapshots.length === 0 ? (
            <Empty className="min-h-20 rounded-md border-0 p-4">
              <EmptyHeader>
                <EmptyDescription className="text-xs text-book-ink-muted">
                  {t.snapshotEmpty}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="flex flex-col gap-1">
              {[...snapshots].reverse().map(s => {
                // Empty label = either the back-filled original_content or
                // an unlabeled manual snapshot. We treat the synthetic
                // `__original__` id as "first draft" explicitly.
                const displayLabel = s.label?.trim()
                  ? s.label
                  : t.snapshotFirstDraftLabel;
                const restoring = restoringId === s.id;
                return (
                  <li key={s.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-book-bg-secondary">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-book-ink-primary">{displayLabel}</div>
                      <div className="text-2xs text-book-ink-muted">{formatRelative(s.createdAt, language)}</div>
                    </div>
                    <Button
                      variant="ghost"
                      type="button"
                      size="sm"
                      onClick={() => handleRestore(s.id)}
                      disabled={restoring}
                      className="h-7 px-2 text-xs gap-1 text-book-ink-secondary hover:text-book-ink-primary"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {t.snapshotRestore}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        <div className="mt-2 text-2xs text-book-ink-muted">{t.snapshotLimitNotice}</div>
      </PopoverContent>
    </Popover>
  );
}
