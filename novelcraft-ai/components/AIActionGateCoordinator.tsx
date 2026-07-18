'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, HardDrive } from 'lucide-react';
import { usePathname } from 'next/navigation';

import { useLanguage } from '@/components/LanguageProvider';
import { openModelsPanel } from '@/components/ModelsPanel';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AI_ACTION_GATE_EVENT,
  MODELS_PANEL_CLOSED_EVENT,
  isAIActionReady,
  type AIActionGateRequest,
} from '@/lib/ai-action-gate';
import { subscribeConnectionsStore } from '@/lib/model-supply/connections';
import { subscribeLocalModelStateChanged } from '@/lib/model-supply/local-model-events';

export function AIActionGateCoordinator() {
  const { t } = useLanguage();
  const pathname = usePathname();
  const pendingRef = useRef<AIActionGateRequest | null>(null);
  const [pending, setPending] = useState<AIActionGateRequest | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);

  const clearPending = useCallback((request: AIActionGateRequest) => {
    if (pendingRef.current?.id !== request.id) return;
    pendingRef.current = null;
    setPending(null);
    setPromptOpen(false);
  }, []);

  const cancelPending = useCallback((reason: 'cancelled' | 'scope-changed' | 'superseded') => {
    const request = pendingRef.current;
    if (!request) return;
    clearPending(request);
    request.reject(reason);
  }, [clearPending]);

  const resumeIfReady = useCallback(async () => {
    const request = pendingRef.current;
    if (!request || !await isAIActionReady(request.operations)) return false;
    clearPending(request);
    request.resolve();
    return true;
  }, [clearPending]);

  useEffect(() => {
    const receiveRequest = (event: Event) => {
      const request = (event as CustomEvent<AIActionGateRequest>).detail;
      if (!request) return;
      request.handled = true;
      pendingRef.current?.reject('superseded');
      pendingRef.current = request;
      setPending(request);
      setPromptOpen(true);
    };
    window.addEventListener(AI_ACTION_GATE_EVENT, receiveRequest);
    return () => {
      window.removeEventListener(AI_ACTION_GATE_EVENT, receiveRequest);
      pendingRef.current?.reject('scope-changed');
      pendingRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    const check = () => { void resumeIfReady(); };
    const unsubscribeConnections = subscribeConnectionsStore(check);
    const unsubscribeLocalModels = subscribeLocalModelStateChanged(check);
    const interval = window.setInterval(check, 750);
    check();
    return () => {
      unsubscribeConnections();
      unsubscribeLocalModels();
      window.clearInterval(interval);
    };
  }, [pending, resumeIfReady]);

  useEffect(() => {
    if (!pending) return;
    const reopenIfStillBlocked = () => {
      void resumeIfReady().then(resumed => {
        if (!resumed && pendingRef.current?.id === pending.id) setPromptOpen(true);
      });
    };
    window.addEventListener(MODELS_PANEL_CLOSED_EVENT, reopenIfStillBlocked);
    return () => window.removeEventListener(MODELS_PANEL_CLOSED_EVENT, reopenIfStillBlocked);
  }, [pending, resumeIfReady]);

  useEffect(() => {
    if (!pending) return;
    if (pathname !== pending.scopePath) cancelPending('scope-changed');
  }, [cancelPending, pathname, pending]);

  const openSetup = (tab: 'local' | 'providers') => {
    setPromptOpen(false);
    openModelsPanel(tab);
  };

  return (
    <Dialog open={promptOpen && pending !== null} onOpenChange={open => {
      if (!open && promptOpen) cancelPending('cancelled');
    }}>
      {pending && (
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-serif text-2xl">{t.aiGateTitle}</DialogTitle>
            <DialogDescription className="leading-relaxed text-book-ink-secondary">
              {t.aiGateDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => openSetup('local')}
              className="h-auto items-start justify-start gap-3 px-4 py-4 text-left"
            >
              <HardDrive className="mt-0.5 h-5 w-5 shrink-0 text-book-gold-dark" />
              <span>
                <span className="block font-semibold text-book-ink-primary">{t.aiGateLocalTitle}</span>
                <span className="mt-1 block whitespace-normal text-xs font-normal leading-relaxed text-book-ink-secondary">
                  {t.aiGateLocalDescription}
                </span>
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => openSetup('providers')}
              className="h-auto items-start justify-start gap-3 px-4 py-4 text-left"
            >
              <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-book-gold-dark" />
              <span>
                <span className="block font-semibold text-book-ink-primary">{t.aiGateOnlineTitle}</span>
                <span className="mt-1 block whitespace-normal text-xs font-normal leading-relaxed text-book-ink-secondary">
                  {t.aiGateOnlineDescription}
                </span>
              </span>
            </Button>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => cancelPending('cancelled')}>
              {t.cancel}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
