'use client';

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function LocalLibraryRecovery({
  placement = 'recovery',
}: {
  placement?: 'recovery' | 'settings';
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      const endpoint = placement === 'settings'
        ? '/api/local-library/clear'
        : '/api/local-library/reset';
      const response = await fetch(endpoint, { method: 'POST' });
      if (!response.ok) throw new Error(`POST ${endpoint} ${response.status}`);
      setConfirming(false);
      toast(t.resetLocalLibrarySuccess, 'success');
      window.location.reload();
    } catch (error) {
      console.error('Local library reset failed:', error);
      toast(t.resetLocalLibraryFailed, 'error');
      setResetting(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant={placement === 'settings' ? 'outline' : 'ghost'}
        size="sm"
        className="self-start text-book-danger hover:bg-book-danger/10 hover:text-book-danger"
        onClick={() => setConfirming(true)}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {placement === 'settings'
          ? t.resetLocalLibrarySettingsAction
          : t.resetLocalLibraryAction}
      </Button>

      <Dialog open={confirming} onOpenChange={open => { if (!resetting) setConfirming(open); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif text-xl">
              {t.resetLocalLibraryTitle}
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-book-ink-secondary">
              {placement === 'settings'
                ? t.clearLocalLibraryDescription
                : t.resetLocalLibraryDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={resetting}
              onClick={() => setConfirming(false)}
              className="h-auto border border-book-border bg-book-bg-card px-4 py-2 text-sm font-medium text-book-ink-primary hover:bg-book-bg-card"
            >
              {t.resetLocalLibraryCancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={resetting}
              onClick={() => void handleReset()}
              className="h-auto px-4 py-2 text-sm font-medium"
            >
              {resetting ? t.resetLocalLibraryBusy : t.resetLocalLibraryConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
