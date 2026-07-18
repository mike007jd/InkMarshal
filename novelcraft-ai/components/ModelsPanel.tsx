'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { CapabilityBindingPanel } from '@/components/CapabilityBindingPanel';
import { ConnectionHealthPanel } from '@/components/ConnectionHealthPanel';
import { LocalModelsPanel } from '@/components/LocalModelsPanel';
import { DiagnosticsPanel } from '@/components/models/DiagnosticsPanel';
import { ProviderConnectionsPanel } from '@/components/ProviderConnectionsPanel';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLanguage } from '@/components/LanguageProvider';
import { MODELS_PANEL_CLOSED_EVENT } from '@/lib/ai-action-gate';

interface ModelsPanelProps {
  open: boolean;
  onClose?: () => void;
}

export type ModelsPanelTab = 'local' | 'providers';

// Allow writing-panel status strips to open the Models drawer.
const OPEN_MODELS_EVENT = 'inkmarshal:open-models';

export function openModelsPanel(defaultTab: ModelsPanelTab = 'local'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_MODELS_EVENT, { detail: { defaultTab } }));
}

export function ModelsPanel({ open, onClose }: ModelsPanelProps) {
  const [eventOpen, setEventOpen] = useState(false);
  const [eventDefaultTab, setEventDefaultTab] = useState<ModelsPanelTab>('local');

  useEffect(() => {
    const openHandler = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { defaultTab?: ModelsPanelTab } : null;
      setEventDefaultTab(detail?.defaultTab ?? 'local');
      setEventOpen(true);
    };
    window.addEventListener(OPEN_MODELS_EVENT, openHandler);
    return () => {
      window.removeEventListener(OPEN_MODELS_EVENT, openHandler);
    };
  }, []);

  const isOpen = open || eventOpen;

  const handleClose = () => {
    setEventOpen(false);
    setEventDefaultTab('local');
    onClose?.();
    window.dispatchEvent(new Event(MODELS_PANEL_CLOSED_EVENT));
  };

  return (
    <Sheet
      open={isOpen}
      onOpenChange={nextOpen => {
        if (!nextOpen && isOpen) handleClose();
      }}
    >
      <ModelsPanelDrawer defaultTab={eventOpen ? eventDefaultTab : 'local'} />
    </Sheet>
  );
}

function ModelsPanelDrawer({
  defaultTab,
}: {
  defaultTab: ModelsPanelTab;
}) {
  const { t } = useLanguage();
  return (
    <SheetContent
      side="right"
      showCloseButton={false}
      aria-describedby={undefined}
      className="w-full gap-0 overflow-hidden border-book-border bg-book-bg-primary p-0 text-book-ink-primary sm:w-[44rem] sm:max-w-none"
    >
      <ModelsPanelSurface
        defaultTab={defaultTab}
        closeControl={
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t.modelManagerCancel}
            >
              <X data-icon="inline-start" aria-hidden />
            </Button>
          </SheetClose>
        }
      />
    </SheetContent>
  );
}

export function ModelsPanelSurface({
  defaultTab = 'local',
  closeControl = null,
}: {
  defaultTab?: ModelsPanelTab;
  closeControl?: ReactNode;
}) {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState(defaultTab);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setActiveTab(defaultTab);
    });
    return () => {
      cancelled = true;
    };
  }, [defaultTab]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-book-bg-primary text-book-ink-primary">
      <SheetHeader className="flex-row items-center justify-between gap-4 border-b border-book-border px-4 py-4 text-left sm:px-5">
        <div className="min-w-0">
          {closeControl ? (
            <SheetTitle className="font-serif text-lg font-semibold text-book-ink-primary">
              {t.modelsTitle}
            </SheetTitle>
          ) : (
            <h1 className="font-serif text-lg font-semibold text-book-ink-primary">
              {t.modelsTitle}
            </h1>
          )}
        </div>
        {closeControl}
      </SheetHeader>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={value => setActiveTab(value as ModelsPanelTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="border-b border-book-border bg-book-bg-primary px-4 sm:px-5">
          <TabsList className="h-auto gap-0 bg-transparent p-0">
            <TabsTrigger
              value="local"
              className="rounded-none border-b-2 border-transparent px-3 py-3 text-sm data-[state=active]:border-book-gold data-[state=active]:text-book-ink-primary data-[state=inactive]:text-book-ink-muted"
            >
              {t.modelsTabLocal}
            </TabsTrigger>
            <TabsTrigger
              value="providers"
              className="rounded-none border-b-2 border-transparent px-3 py-3 text-sm data-[state=active]:border-book-gold data-[state=active]:text-book-ink-primary data-[state=inactive]:text-book-ink-muted"
            >
              {t.modelsTabProviders}
            </TabsTrigger>
          </TabsList>
        </div>

        <ScrollArea className="min-h-0 flex-1 overflow-x-hidden">
          <TabsContent value="local" className="m-0 p-4 sm:p-5">
            {/* Health alerts (no model / dangling binding / low disk) lead the
                tab so real problems surface before the long coverage + shelf
                stack. DiagnosticsPanel self-hides when there are no issues, so
                promoting it costs nothing in the healthy state. */}
            <div className="mb-6 empty:mb-0">
              <DiagnosticsPanel includeNoModels={false} />
            </div>
            <LocalModelsPanel openProviders={() => setActiveTab('providers')} />
          </TabsContent>

          <TabsContent value="providers" className="m-0 p-4 sm:p-5">
            <div className="flex flex-col gap-8">
              <div>
                <ProviderConnectionsPanel />
              </div>
              <div className="border-t border-book-border pt-4">
                <ConnectionHealthPanel />
              </div>
              <div className="border-t border-book-border pt-4">
                <CapabilityBindingPanel hideWhenUnavailable />
              </div>
            </div>
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </div>
  );
}
