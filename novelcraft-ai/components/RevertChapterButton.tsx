'use client';

import { useCallback, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

interface RevertChapterButtonProps {
  novelId: string;
  chapterNumber: number;
  chapterVersion: number;
  /** Caller passes whether `chapter.originalContent` is non-null. Empty string
   *  is a valid first draft and must still be reversible. */
  hasOriginal: boolean;
  /** Fires after a successful revert (or successful undo-revert). The parent
   *  is expected to refetch chapter content. */
  onReverted?: () => void;
  /** Flush unsaved editor content before reverting. */
  onBeforeAction?: () => Promise<boolean>;
  /** Current unsaved editor buffer, used for the undo stash. */
  getCurrentContent?: () => string | null;
}

/** Window during which the toast "Undo revert" link is valid. After this the
 *  pre-revert content is dropped from memory. */
const UNDO_WINDOW_MS = 8000;

export function RevertChapterButton({
  novelId,
  chapterNumber,
  chapterVersion,
  hasOriginal,
  onReverted,
  onBeforeAction,
  getCurrentContent,
}: RevertChapterButtonProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Stash the content that was current right before revert, so we can offer a
  // single 5s "undo" PATCH back. Kept in a ref so the closure on the toast
  // action button always sees the latest snapshot.
  const undoStashRef = useRef<{ content: string; expiresAt: number } | null>(null);

  const performRevert = useCallback(async () => {
    setConfirmOpen(false);
    setBusy(true);
    try {
      if (onBeforeAction && !(await onBeforeAction())) return;
      // Step 1: fetch current chapter so we can stash content for undo.
      // (`/api/novels/[id]/chapters/[n]` GET isn't a thing today — fall back
      //  to the list endpoint and pick our chapter.)
      let preRevertContent: string | null = getCurrentContent?.() ?? null;
      try {
        if (preRevertContent === null) {
          const r = await fetch(`/api/novels/${novelId}/chapters`);
          if (r.ok) {
            const data = await r.json();
            const list: Array<{ chapterNumber: number; content: string }> = Array.isArray(data?.chapters)
              ? data.chapters
              : Array.isArray(data)
                ? data
                : [];
            const hit = list.find(c => c.chapterNumber === chapterNumber);
            if (hit) preRevertContent = hit.content;
          }
        }
      } catch {
        // Best-effort; undo just won't be offered if we couldn't stash.
      }

      // Step 2: hit the revert API.
      const res = await fetch(
        `/api/novels/${novelId}/chapters/${chapterNumber}/revert`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: chapterVersion }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as { error?: string }));
        throw new Error((err as { error?: string }).error || 'Revert failed');
      }
      const reverted = await res.json().catch(() => ({} as { version?: unknown }));
      const undoVersion = typeof reverted.version === 'number' ? reverted.version : undefined;

      // Stash + arm the undo window only if we got the pre-revert content.
      if (preRevertContent !== null) {
        undoStashRef.current = {
          content: preRevertContent,
          expiresAt: Date.now() + UNDO_WINDOW_MS,
        };
      }

      onReverted?.();

      const undoAction = preRevertContent !== null
        ? {
            label: t.revertChapterUndo,
            onClick: () => {
              const stash = undoStashRef.current;
              if (!stash || Date.now() > stash.expiresAt) return;
              fetch(`/api/novels/${novelId}/chapters/${chapterNumber}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: stash.content, version: undoVersion }),
              }).then(r => {
                if (r.ok) onReverted?.();
              }).catch(() => {});
              undoStashRef.current = null;
            },
          }
        : undefined;
      toast(t.revertChapterSuccess, 'success', { action: undoAction, durationMs: UNDO_WINDOW_MS });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Revert failed', 'error');
    } finally {
      setBusy(false);
    }
  }, [novelId, chapterNumber, chapterVersion, onReverted, onBeforeAction, getCurrentContent, toast, t.revertChapterUndo, t.revertChapterSuccess]);

  if (!hasOriginal) return null;

  return (
    <>
      <Button
        variant="ghost"
        type="button"
        size="sm"
        onClick={() => setConfirmOpen(true)}
        disabled={busy}
        className="h-7 px-2 text-xs gap-1 text-book-ink-secondary hover:text-book-ink-primary"
        title={t.revertChapterButton}
      >
        <Undo2 className="w-3.5 h-3.5" />
        <span>{t.revertChapterButton}</span>
      </Button>

      <Dialog open={confirmOpen} onOpenChange={(o) => { if (!o) setConfirmOpen(false); }}>
        {confirmOpen && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="font-serif text-xl">{t.revertChapterConfirmTitle}</DialogTitle>
              <DialogDescription className="text-book-ink-secondary leading-relaxed">
                {t.revertChapterConfirmBody}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="h-auto border border-book-border bg-book-bg-card px-4 py-2 text-sm font-medium text-book-ink-primary hover:bg-book-bg-card"
              >
                {t.cancel}
              </Button>
              <Button
                variant="accent"
                type="button"
                onClick={performRevert}
                className="h-auto px-4 py-2 text-sm font-medium"
              >
                {t.revertChapterButton}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
