'use client';

import { FileText, Globe, Users } from 'lucide-react';

import { KnowledgePanel } from '@/components/knowledge/KnowledgePanel';
import { useLanguage } from '@/components/LanguageProvider';
import type { DeckCounts, StoryDeckRepairPhase } from '@/components/novel-workspace/types';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { KnowledgeFilterTab } from '@/lib/knowledge-workspace';

export function StoryDeckWorkspacePane({
  novelId,
  tab,
  onTabChange,
  refreshToken,
  coverageCounts,
  coverageLoading = false,
  repairPhase = 'idle',
  assistantBusy = false,
  onCompleteDeck,
  onEntriesMutated,
}: {
  novelId: string;
  tab: KnowledgeFilterTab;
  onTabChange: (tab: KnowledgeFilterTab) => void;
  refreshToken: number;
  coverageCounts: DeckCounts;
  coverageLoading?: boolean;
  repairPhase?: StoryDeckRepairPhase;
  assistantBusy?: boolean;
  onCompleteDeck?: () => void;
  onEntriesMutated: () => void;
}) {
  const { t } = useLanguage();
  const tabs: ReadonlyArray<{
    key: KnowledgeFilterTab;
    label: string;
    Icon: typeof Users;
  }> = [
    { key: 'character', label: t.storyDeckCharacters, Icon: Users },
    { key: 'world', label: t.storyDeckWorld, Icon: Globe },
    { key: 'outline', label: t.storyDeckOutline, Icon: FileText },
  ];

  return (
    <section className="flex h-full min-h-0 flex-col bg-book-bg-primary">
      <div className="border-b border-book-border px-5 py-4">
        <div className="font-serif text-xl font-semibold text-book-ink-primary">
          {t.storyDeckTitle}
        </div>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-book-ink-muted">
          {t.storyDeckSubtitle}
        </p>
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as KnowledgeFilterTab)}
        className="border-b border-book-border bg-book-bg-secondary/60 p-2 sm:max-w-xl"
      >
        <TabsList className="grid w-full grid-cols-3 gap-1 border-0">
          {tabs.map(({ key, label, Icon }) => (
            <TabsTrigger
              key={key}
              value={key}
              className="flex items-center justify-center gap-1.5 rounded-md border-0 px-2 py-1.5 text-xs font-medium data-[state=active]:border-b-transparent data-[state=active]:bg-book-bg-card data-[state=active]:text-book-ink-primary data-[state=active]:shadow-sm"
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="truncate">{label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="min-h-0 flex-1">
        <KnowledgePanel
          novelId={novelId}
          controlledFilter={tab}
          variant="deck"
          refreshToken={refreshToken}
          coverageCounts={coverageCounts}
          coverageLoading={coverageLoading}
          repairPhase={repairPhase}
          assistantBusy={assistantBusy}
          onCompleteDeck={onCompleteDeck}
          onEntriesMutated={onEntriesMutated}
        />
      </div>
    </section>
  );
}
