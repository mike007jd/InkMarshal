'use client';

import { useRef, useState } from 'react';
import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

export function DeleteNovelDialog({
  open,
  title,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      {open && <DeleteNovelDialogBody title={title} onConfirm={onConfirm} onCancel={onCancel} />}
    </Dialog>
  );
}

function DeleteNovelDialogBody({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const { t } = useLanguage();
  const confirmingRef = useRef(false);
  const [confirming, setConfirming] = useState(false);

  const handleConfirm = async () => {
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  };

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle className="font-serif text-2xl">{t.moveToTrashTitle}</DialogTitle>
        <DialogDescription className="text-book-ink-secondary leading-relaxed break-words">
          <span className="font-medium">{title}</span> · {t.moveToTrashDescription}
        </DialogDescription>
      </DialogHeader>

      <DialogFooter>
        <Button
          variant="ghost"
          type="button"
          onClick={onCancel}
          className="h-auto border border-book-border bg-book-bg-card px-4 py-2 text-sm font-medium text-book-ink-primary hover:bg-book-bg-card"
        >
          {t.cancel}
        </Button>
        <Button
          variant="ink"
          type="button"
          onClick={() => void handleConfirm()}
          disabled={confirming}
          className="h-auto px-4 py-2 text-sm font-medium"
        >
          {confirming ? t.loading : t.moveToTrashAction}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
