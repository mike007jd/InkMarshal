'use client';

import { useEffect, useState, type RefObject } from 'react';
import { ArchiveRestore, Trash2 } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { isUsableReturnFocusTarget } from '@/components/ui/focus-utils';
import { Spinner } from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { Novel } from '@/lib/db-types';
import { notifyNovelListInvalidated } from '@/lib/use-storage';

export function TrashPanel({
  open,
  onOpenChange,
  returnFocusRef,
  fallbackFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stable opener (e.g. More tools). Avoids Radix restoring into a removed menu portal. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Visible narrow-shell control used when the opener leaves the layout. */
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t, locale } = useLanguage();
  const { toast } = useToast();
  const [novels, setNovels] = useState<Novel[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Novel | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setLoadError(false);
      void fetch('/api/trash', { cache: 'no-store' })
        .then(response => response.ok ? response.json() as Promise<Novel[]> : Promise.reject(new Error('load_failed')))
        .then(items => { if (!cancelled) setNovels(items); })
        .catch(() => {
          if (cancelled) return;
          setLoadError(true);
          toast(t.trashLoadFailed, 'error');
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    });
    return () => { cancelled = true; };
  }, [open, retryToken, t.trashLoadFailed, toast]);

  const restore = async (novel: Novel) => {
    if (busyId) return;
    setBusyId(novel.id);
    try {
      const response = await fetch(`/api/trash/${novel.id}/restore`, { method: 'POST' });
      if (!response.ok) throw new Error('restore_failed');
      setNovels(current => current.filter(item => item.id !== novel.id));
      notifyNovelListInvalidated();
      toast(t.trashRestoreSuccess.replace('{title}', novel.title), 'success');
    } catch {
      toast(t.trashRestoreFailed, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const permanentlyDelete = async () => {
    if (!deleteTarget || busyId) return;
    const target = deleteTarget;
    setBusyId(target.id);
    try {
      const response = await fetch(`/api/trash/${target.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('delete_failed');
      setNovels(current => current.filter(item => item.id !== target.id));
      setDeleteTarget(null);
      toast(t.trashDeleteSuccess.replace('{title}', target.title), 'success');
    } catch {
      toast(t.trashDeleteFailed, 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full border-book-border bg-book-bg-primary p-0 sm:max-w-lg"
          onCloseAutoFocus={event => {
            const returnTarget = returnFocusRef?.current ?? null;
            const fallbackTarget = fallbackFocusRef?.current ?? null;
            const focusTarget = isUsableReturnFocusTarget(returnTarget)
              ? returnTarget
              : isUsableReturnFocusTarget(fallbackTarget)
                ? fallbackTarget
                : null;
            if (!focusTarget) return;
            event.preventDefault();
            focusTarget.focus({ preventScroll: true });
          }}
        >
          <SheetHeader className="border-b border-book-border px-5 py-4 text-left">
            <SheetTitle className="font-serif text-xl">{t.trashTitle}</SheetTitle>
            <SheetDescription>{t.trashDescription}</SheetDescription>
          </SheetHeader>
          <div className="h-full overflow-y-auto p-4">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-book-ink-muted">
                <Spinner /> {t.loading}
              </div>
            ) : loadError ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <p className="text-sm text-book-danger">{t.trashLoadFailed}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRetryToken(value => value + 1)}
                >
                  {t.toastRetry}
                </Button>
              </div>
            ) : novels.length === 0 ? (
              <div className="py-12 text-center font-serif text-sm italic text-book-ink-muted">{t.trashEmpty}</div>
            ) : (
              <div className="space-y-2">
                {novels.map(novel => (
                  <div key={novel.id} className="rounded-lg border border-book-border bg-book-bg-card p-3">
                    <div className="font-serif text-sm font-semibold text-book-ink-primary">{novel.title}</div>
                    <div className="mt-1 text-xs text-book-ink-muted">
                      {t.trashMovedAt.replace(
                        '{date}',
                        new Date(novel.settings?.trashedAt ?? novel.updatedAt).toLocaleString(locale),
                      )}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button type="button" size="sm" variant="outline" disabled={busyId !== null} onClick={() => void restore(novel)}>
                        {busyId === novel.id ? <Spinner /> : <ArchiveRestore className="size-4" />}
                        {t.trashRestoreAction}
                      </Button>
                      <Button type="button" size="sm" variant="ghost" disabled={busyId !== null} onClick={() => setDeleteTarget(novel)} className="text-book-danger hover:text-book-danger">
                        <Trash2 className="size-4" /> {t.trashDeletePermanently}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
      <PermanentDeleteDialog
        key={deleteTarget?.id ?? 'closed'}
        novel={deleteTarget}
        busy={deleteTarget !== null && busyId === deleteTarget.id}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={permanentlyDelete}
      />
    </>
  );
}

function PermanentDeleteDialog({
  novel,
  busy,
  onCancel,
  onConfirm,
}: {
  novel: Novel | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLanguage();
  return (
    <Dialog open={novel !== null} onOpenChange={next => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">{t.trashDeleteConfirmTitle}</DialogTitle>
          <DialogDescription>{t.trashDeleteConfirmDescription.replace('{title}', novel?.title ?? '')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>{t.cancel}</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void onConfirm()}>
            {busy ? <Spinner /> : null}
            {t.trashDeletePermanently}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
