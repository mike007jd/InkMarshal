'use client';

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import {
  BookUser,
  Globe,
  Clock,
  FileText,
  Paintbrush,
  Plus,
  Search,
  Layers,
  MessageSquare,
} from 'lucide-react';
import type { KnowledgeEntry, KnowledgeType, OutlineEntry } from '@/lib/types/knowledge';
import { KnowledgeEntryForm } from './KnowledgeEntryForm';
import { useLocale } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/Toast';
import type { StringKey } from '@/lib/i18n';
import { CardDecoration, type DecorationType } from '@/components/ui/CardDecoration';
import {
  buildKnowledgeEntriesUrl,
  KNOWLEDGE_FILTER_TABS,
  summarizeKnowledgeEntryPreview,
  type KnowledgeFilterTab,
} from '@/lib/knowledge-workspace';

interface KnowledgePanelProps {
  novelId: string;
  /** When present, the panel renders entries filtered by the outer
   *  `controlledFilter` and hides its internal tab row. Backwards-compatible:
   *  callers that don't pass this prop keep the old self-tabbed behaviour. */
  controlledFilter?: KnowledgeFilterTab;
  /** Bumped by the parent when entries may have changed outside the panel
   *  (e.g. a brainstorm turn wrote new cards). Any change refetches
   *  immediately. */
  refreshToken?: number;
  variant?: 'workspace' | 'deck';
  /** Coverage across the three Story Deck collections, resolved by the
   *  parent (the panel only fetches the active filter). Rendered as count
   *  badges on the internal tabs and on the deck header. */
  coverageCounts?: Partial<Record<'character' | 'world' | 'outline', number>>;
  /** When provided, empty tabs offer a path back to the Assistant so the
   *  user can finish the brainstorm instead of hand-authoring cards. */
  onReturnToAssistant?: () => void;
  returnToAssistantLabel?: string;
}

const TAB_ICONS: Record<KnowledgeFilterTab, React.ComponentType<{ size?: number }>> = {
  all: Layers,
  character: BookUser,
  world: Globe,
  timeline: Clock,
  outline: FileText,
  style_reference: Paintbrush,
};

const TYPE_ICONS: Record<KnowledgeType, React.ComponentType<{ size?: number; className?: string }>> = {
  character: BookUser,
  world: Globe,
  timeline: Clock,
  outline: FileText,
  style_reference: Paintbrush,
};

const TYPE_CARD_ACCENT: Record<KnowledgeType, string> = {
  character: 'paper-card-character',
  world: 'paper-card-world',
  timeline: 'paper-card-timeline',
  outline: 'paper-card-outline',
  style_reference: 'paper-card-style',
};

const TYPE_ICON_BG: Record<KnowledgeType, string> = {
  character: 'bg-book-warning-light',
  world: 'bg-book-info/10',
  timeline: 'bg-book-success-light',
  outline: 'bg-book-gold/10',
  style_reference: 'bg-book-violet/10',
};

const TYPE_LABEL_COLOR: Record<KnowledgeType, string> = {
  character: 'text-book-gold-dark',
  world: 'text-book-info',
  timeline: 'text-book-success',
  outline: 'text-book-gold',
  style_reference: 'text-book-violet',
};

const TYPE_DECORATION: Record<KnowledgeType, DecorationType> = {
  character: 'pushpin',
  world: 'tape',
  timeline: 'paperclip',
  outline: 'pushpin',
  style_reference: 'tape',
};

const TYPE_LABEL_KEYS: Record<KnowledgeType, StringKey> = {
  character: 'knowledgeTypeCharacter',
  world: 'knowledgeTypeWorld',
  timeline: 'knowledgeTypeTimeline',
  outline: 'knowledgeTypeOutline',
  style_reference: 'knowledgeTypeStyle',
};

interface OutlineDeckRow {
  entry: OutlineEntry;
  depth: number;
}

export function buildOutlineDeckRows(entries: readonly KnowledgeEntry[]): OutlineDeckRow[] {
  const outlines = entries.filter((entry): entry is OutlineEntry => entry.type === 'outline');
  const ids = new Set(outlines.map(entry => entry.id));
  const children = new Map<string, OutlineEntry[]>();
  const roots: OutlineEntry[] = [];
  const sort = (a: OutlineEntry, b: OutlineEntry) =>
    a.data.chapterNumber - b.data.chapterNumber ||
    a.sortOrder - b.sortOrder ||
    a.title.localeCompare(b.title);

  for (const entry of outlines) {
    const parentId = entry.data.parentId;
    if (!parentId || !ids.has(parentId)) {
      roots.push(entry);
      continue;
    }
    const siblings = children.get(parentId) ?? [];
    siblings.push(entry);
    children.set(parentId, siblings);
  }
  roots.sort(sort);
  for (const siblings of children.values()) siblings.sort(sort);

  const rows: OutlineDeckRow[] = [];
  const visited = new Set<string>();
  const visit = (entry: OutlineEntry, depth: number) => {
    if (visited.has(entry.id)) return;
    visited.add(entry.id);
    rows.push({ entry, depth });
    for (const child of children.get(entry.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // Cycles or malformed parent chains stay visible at the root instead of
  // disappearing from the authoring surface.
  for (const entry of outlines.sort(sort)) {
    if (!visited.has(entry.id)) visit(entry, 0);
  }
  return rows;
}

export function KnowledgePanel({
  novelId,
  controlledFilter,
  refreshToken = 0,
  variant = 'workspace',
  coverageCounts,
  onReturnToAssistant,
  returnToAssistantLabel,
}: KnowledgePanelProps) {
  const { t } = useLocale();
  const { toast } = useToast();
  const [internalTab, setInternalTab] = useState<KnowledgeFilterTab>('all');
  const activeTab: KnowledgeFilterTab = controlledFilter ?? internalTab;
  const setActiveTab = setInternalTab;
  const showInternalTabs = controlledFilter === undefined;
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [editingEntry, setEditingEntry] = useState<KnowledgeEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNovelRef = useRef(novelId);
  const fetchSeqRef = useRef(0);

  useLayoutEffect(() => {
    activeNovelRef.current = novelId;
    fetchSeqRef.current += 1;
  }, [novelId]);

  // Hard-reset only when the NOVEL changes — switching books must not show the
  // previous book's entries. A filter/tab change must NOT wipe the grid: the
  // fetch effect swaps entries in place (stale-while-revalidate), so switching
  // Deck tabs no longer flashes cards→blank→loading→cards.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSearchQuery('');
      setDebouncedQuery('');
      setEntries([]);
      setLoading(false);
      setLoadError(false);
      setEditingEntry(null);
      setCreating(false);
      if (controlledFilter === undefined) setInternalTab('all');
    });
    return () => {
      cancelled = true;
    };
    // controlledFilter intentionally excluded: a filter change refetches (below)
    // without blanking the current list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [novelId]);

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  const fetchEntries = useCallback(async () => {
    const requestNovelId = novelId;
    const requestSeq = ++fetchSeqRef.current;
    const isCurrentRequest = () =>
      activeNovelRef.current === requestNovelId && fetchSeqRef.current === requestSeq;
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(buildKnowledgeEntriesUrl(novelId, {
        filter: activeTab,
        search: debouncedQuery,
      }));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as KnowledgeEntry[];
      if (isCurrentRequest()) setEntries(json);
    } catch (error) {
      if (isCurrentRequest()) {
        console.error('Failed to fetch knowledge entries:', error);
        setEntries([]);
        // Panel-local error + Retry keeps the failure where the user is
        // looking; the toast remains as the ambient heads-up.
        setLoadError(true);
        toast(t.errorLoadKnowledge, 'error', {
          action: { label: t.toastRetry, onClick: () => setRetryToken(value => value + 1) },
        });
      }
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [novelId, activeTab, debouncedQuery, t.errorLoadKnowledge, t.toastRetry, toast]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void fetchEntries();
    });
    return () => {
      cancelled = true;
    };
  }, [fetchEntries, refreshToken, retryToken]);

  const handleSaved = () => {
    setEditingEntry(null);
    setCreating(false);
    void fetchEntries();
  };

  const handleClose = () => {
    setEditingEntry(null);
    setCreating(false);
  };

  const isDeck = variant === 'deck';
  const isOutlineDeck = isDeck && activeTab === 'outline';
  const outlineRows = isOutlineDeck ? buildOutlineDeckRows(entries) : [];

  return (
    <div className="flex h-full flex-col">
      {/* Search + Add on one row. The old standalone "Knowledge Base" heading row
          was dropped — the outer subview nav (Characters/World/Style) already
          labels this section, so the caption was a redundant ~48px chrome row
          above the card grid (2026-06-25 screen-density audit). */}
      <div className={isDeck ? 'flex items-center gap-2 px-3 py-2' : 'flex items-center gap-2 px-4 py-2'}>
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-book-ink-muted" />
          <Input
            variant="boxed"
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t.knowledgeSearchPlaceholder}
            className="w-full rounded-md border border-book-border bg-book-bg-secondary py-1.5 pl-8 pr-3 text-xs text-book-ink-primary placeholder:text-book-ink-muted focus:outline-none focus:ring-2 focus:ring-book-accent"
          />
        </div>
        <Button
          variant="accent"
          onClick={() => { setCreating(true); setEditingEntry(null); }}
          className="h-auto shrink-0 gap-1 px-2 py-1.5 text-xs font-medium"
        >
          <Plus size={14} />
          {t.knowledgeAdd}
        </Button>
      </div>

      {/* Filter tabs — hidden when an outer parent drives filter via controlledFilter */}
      {showInternalTabs && (
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as KnowledgeFilterTab)} className="px-4 pb-2">
          <TabsList className="grid w-full grid-cols-3 gap-1 rounded-lg border-0 bg-book-bg-secondary p-1 lg:grid-cols-6">
            {KNOWLEDGE_FILTER_TABS.map(tab => {
              const Icon = TAB_ICONS[tab.key];
              const coverage = tab.key === 'character' || tab.key === 'world' || tab.key === 'outline'
                ? coverageCounts?.[tab.key]
                : undefined;
              return (
                <TabsTrigger
                  key={tab.key}
                  value={tab.key}
                  className="gap-1 rounded-md border-0 px-2 py-1 text-xs data-[state=active]:bg-book-ink-primary data-[state=active]:text-book-bg-card data-[state=active]:border-b-transparent"
                >
                  <Icon size={12} />
                  <span className="truncate">{t[tab.labelKey]}</span>
                  {coverage !== undefined && (
                    <span className="shrink-0 tabular-nums text-2xs opacity-70">{coverage}</span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
      )}

      {/* Content area */}
      <div className={isDeck ? 'flex-1 overflow-y-auto px-3 pb-3' : 'flex-1 overflow-y-auto px-4 pb-4'}>
        {/* Inline form */}
        {(creating || editingEntry) && (
          <div className={isDeck ? 'mb-3 rounded-lg border border-book-border bg-book-bg-primary p-3' : 'mb-4 rounded-lg border border-book-border bg-book-bg-primary p-4'}>
            <KnowledgeEntryForm
              key={editingEntry?.id ?? 'new'}
              novelId={novelId}
              entry={editingEntry ?? undefined}
              onClose={handleClose}
              onSaved={handleSaved}
            />
          </div>
        )}

        {/* Deck coverage summary — the three Story Deck collections at a
            glance, resolved by the parent (the panel only fetches the
            active filter). */}
        {isDeck && coverageCounts && (
          <div className="mb-2 flex items-center gap-3 px-1 pt-1 text-2xs font-medium text-book-ink-muted">
            <span className="tabular-nums">{t.storyDeckCharacters} {coverageCounts.character ?? 0}</span>
            <span className="tabular-nums">{t.storyDeckWorld} {coverageCounts.world ?? 0}</span>
            <span className="tabular-nums">{t.storyDeckOutline} {coverageCounts.outline ?? 0}</span>
          </div>
        )}

        {/* Loading — skeleton cards mirror the paper-card grid so the panel
            never flashes blank between filters. */}
        {loading && !entries.length && (
          <div
            aria-busy="true"
            aria-label={t.loading}
            className={isDeck ? 'grid grid-cols-1 gap-3 pt-2 md:grid-cols-2 xl:grid-cols-3' : 'grid grid-cols-1 sm:grid-cols-2 gap-5 pt-2'}
          >
            {[0, 1, 2].map(index => (
              <div
                key={index}
                className="motion-essential animate-pulse rounded-lg border border-book-border bg-book-bg-card p-4"
              >
                <div className="mb-3 flex items-center gap-2.5 border-b border-book-border pb-2">
                  <div className="h-7 w-7 rounded-lg bg-book-bg-secondary" />
                  <div className="flex-1">
                    <div className="mb-1 h-2 w-16 rounded bg-book-bg-secondary" />
                    <div className="h-3 w-24 rounded bg-book-bg-secondary" />
                  </div>
                </div>
                <div className="mb-1.5 h-2.5 w-full rounded bg-book-bg-secondary" />
                <div className="h-2.5 w-2/3 rounded bg-book-bg-secondary" />
              </div>
            ))}
          </div>
        )}

        {/* Panel-local load failure — retry stays where the user is looking. */}
        {!loading && loadError && (
          <div
            role="alert"
            className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-book-danger-border bg-book-danger-light px-3 py-2"
          >
            <p className="text-xs text-book-danger">{t.errorLoadKnowledge}</p>
            <Button
              variant="outline"
              type="button"
              onClick={() => setRetryToken(value => value + 1)}
              className="h-auto shrink-0 px-3 py-1.5 text-xs font-medium"
            >
              {t.toastRetry}
            </Button>
          </div>
        )}

        {/* Empty state — distinguish "no matches for this search" from the
            genuine first-run "nothing here yet". Every tab names what is
            missing and, when the brainstorm is the intended source, offers a
            path back to the Assistant to finish it. */}
        {!loading && !loadError && !entries.length && !creating && (
          <Empty className="border-0 p-0 py-12 md:p-0 md:py-12">
            <EmptyHeader>
              <EmptyMedia>
                <Layers size={isDeck ? 24 : 32} className="text-book-ink-muted" />
              </EmptyMedia>
              {debouncedQuery.trim() ? (
                <EmptyTitle className="text-sm font-normal text-book-ink-muted">
                  {t.knowledgeNoSearchResults.replace('{query}', debouncedQuery.trim())}
                </EmptyTitle>
              ) : (
                <>
                  <EmptyTitle className="text-sm font-normal text-book-ink-muted">
                    {t.knowledgeNoEntries}
                  </EmptyTitle>
                  <EmptyDescription className="text-xs text-book-ink-muted">
                    {activeTab === 'character'
                      ? t.knowledgeNoEntriesHintCharacter
                      : activeTab === 'world'
                        ? t.knowledgeNoEntriesHintWorld
                        : activeTab === 'style_reference'
                          ? t.knowledgeNoEntriesHintStyle
                          : t.knowledgeNoEntriesHint}
                  </EmptyDescription>
                </>
              )}
            </EmptyHeader>
            {!debouncedQuery.trim() && onReturnToAssistant && (
              <EmptyContent className="mt-3">
                <Button
                  variant="outline"
                  type="button"
                  onClick={onReturnToAssistant}
                  className="h-auto gap-1.5 px-3 py-2 text-xs font-medium"
                >
                  <MessageSquare size={14} />
                  {returnToAssistantLabel ?? t.storyDeckReturnAssistant}
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}

        {isOutlineDeck ? (
          <div className="pt-2">
            {entries.length > 0 && (
              <div className="mb-2 flex items-center justify-between border-b border-book-border px-2 pb-2 text-xs text-book-ink-muted">
                <span className="font-semibold uppercase tracking-wider">{t.storyDeckOutline}</span>
                <span>{t.outlineEntriesCount.replace('{count}', String(outlineRows.length))}</span>
              </div>
            )}
            <div className="space-y-1" role="tree" aria-label={t.storyDeckOutline}>
              {outlineRows.map(({ entry, depth }) => {
                const summary = summarizeKnowledgeEntryPreview(entry);
                const level = entry.data.level;
                const levelLabel = level === 'volume'
                  ? t.outlineLevelVolume
                  : level === 'scene'
                    ? t.outlineLevelScene
                    : level === 'beat'
                      ? t.outlineLevelBeat
                      : t.outlineLevelChapter;
                const indent = depth === 0
                  ? 'pl-3'
                  : depth === 1
                    ? 'pl-7'
                    : depth === 2
                      ? 'pl-11'
                      : 'pl-14';
                return (
                  <Button
                    key={entry.id}
                    variant="unstyled"
                    size="unstyled"
                    role="treeitem"
                    aria-level={depth + 1}
                    onClick={() => { setEditingEntry(entry); setCreating(false); }}
                    className={`group flex w-full items-center gap-3 border border-transparent ${indent} pr-3 py-2 text-left transition-feedback hover:border-book-border hover:bg-book-bg-card`}
                  >
                    <span className="w-16 shrink-0 text-2xs font-semibold uppercase tracking-wider text-book-gold-dark">
                      {level === 'chapter'
                        ? `${t.blueprintChapterLabel}${entry.data.chapterNumber}`
                        : levelLabel}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-serif text-sm font-semibold text-book-ink-primary">
                        {entry.title}
                      </span>
                      {summary && (
                        <span className="mt-0.5 block truncate text-xs text-book-ink-muted">
                          {summary}
                        </span>
                      )}
                    </span>
                    <FileText size={14} className="shrink-0 text-book-ink-muted opacity-0 transition-feedback group-hover:opacity-100 group-focus-visible:opacity-100" />
                  </Button>
                );
              })}
            </div>
          </div>
        ) : (
        /* Entry cards — paper-card grid */
        <div className={isDeck ? 'grid grid-cols-1 gap-3 pt-2 md:grid-cols-2 xl:grid-cols-3' : 'grid grid-cols-1 sm:grid-cols-2 gap-5 pt-2'}>
          {entries.map((entry) => {
            const Icon = TYPE_ICONS[entry.type];
            const summary = summarizeKnowledgeEntryPreview(entry);
            const accentClass = TYPE_CARD_ACCENT[entry.type];
            const iconBg = TYPE_ICON_BG[entry.type];
            const labelColor = TYPE_LABEL_COLOR[entry.type];
            const decoration = TYPE_DECORATION[entry.type];
            return (
              <Button
                key={entry.id}
                variant="unstyled"
                size="unstyled"
                onClick={() => { setEditingEntry(entry); setCreating(false); }}
                className={`paper-card ${accentClass} flex w-full flex-col items-stretch justify-start gap-0 whitespace-normal text-left font-normal`}
              >
                <CardDecoration type={decoration} />
                <div className="flex items-center justify-between border-b border-book-border pb-2 mb-3">
                  <div className="flex items-center gap-2.5">
                    <div className={`shrink-0 flex items-center justify-center ${isDeck ? 'h-7 w-7' : 'w-8 h-8'} rounded-lg ${iconBg}`}>
                      <Icon size={16} className={labelColor} />
                    </div>
                    <div className="min-w-0">
                      <p className={`text-2xs font-semibold uppercase tracking-wider ${labelColor}`}>
                        {t[TYPE_LABEL_KEYS[entry.type]]}
                      </p>
                      <p className="truncate text-chat font-serif font-semibold text-book-ink-primary leading-tight">
                        {entry.title}
                      </p>
                    </div>
                  </div>
                </div>
                {summary && (
                  <p className="text-sm text-book-ink-secondary leading-relaxed line-clamp-2">
                    {summary}
                  </p>
                )}
                {entry.tags.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {entry.tags.map(tag => (
                      <span
                        key={tag}
                        className="rounded-full bg-book-bg-secondary px-2 py-0.5 text-2xs font-medium text-book-ink-secondary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </Button>
            );
          })}
        </div>
        )}
      </div>
    </div>
  );
}
