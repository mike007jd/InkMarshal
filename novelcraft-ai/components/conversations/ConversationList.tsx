'use client';

import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { Plus, ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import type { Conversation } from '@/lib/types/conversation';
import { CONVERSATION_TOPICS } from '@/lib/types/conversation';
import { useLocale } from '@/components/LanguageProvider';
import { formatRelativeTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { StringKey } from '@/lib/i18n';

/* ── Topic colours — book-themed ── */
const TOPIC_COLORS: Record<string, { bg: string; text: string; labelKey: StringKey }> = {
  general:         { bg: 'bg-book-bg-secondary', text: 'text-book-ink-muted',  labelKey: 'conversationTopicGeneral' },
  plot:            { bg: 'bg-book-info/10',       text: 'text-book-info',       labelKey: 'conversationTopicPlot' },
  characters:      { bg: 'bg-book-warning-light', text: 'text-book-gold-dark',  labelKey: 'conversationTopicCharacters' },
  worldbuilding:   { bg: 'bg-book-violet/10',     text: 'text-book-violet',     labelKey: 'conversationTopicWorldbuilding' },
  chapter_editing: { bg: 'bg-book-warning-light', text: 'text-book-gold-dark', labelKey: 'conversationTopicChapterEditing' },
};

function topicMeta(topic: string) {
  return TOPIC_COLORS[topic] ?? TOPIC_COLORS.general;
}

/* ── Topic badge ── */
function TopicBadge({ topic }: { topic: string }) {
  const { t } = useLocale();
  const meta = topicMeta(topic);
  return (
    <span
      data-testid={`topic-badge-${topic}`}
      // shrink-0 + whitespace-nowrap: in the narrow (w-72) thread list the badge
      // must keep its full width so the sibling flex-1 title truncates instead of
      // the badge clipping its own text ("hapter Editing").
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium ${meta.bg} ${meta.text}`}
    >
      {t[meta.labelKey]}
    </span>
  );
}

/* ── Main component ── */
interface ConversationListProps {
  novelId: string;
  activeConvId: string | null;
  onSelectConversation: (id: string) => void;
  onCreateConversation: (topic: string, title: string) => void | Promise<void>;
}

export function ConversationList({
  novelId,
  activeConvId,
  onSelectConversation,
  onCreateConversation,
}: ConversationListProps) {
  const { t } = useLocale();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* Create-form state */
  const [showCreate, setShowCreate] = useState(false);
  const [newTopic, setNewTopic] = useState<string>('general');
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  /* Collapsed groups */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const activeNovelRef = useRef(novelId);

  useLayoutEffect(() => {
    activeNovelRef.current = novelId;
  }, [novelId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setConversations([]);
      setLoading(true);
      setError(null);
      setShowCreate(false);
      setNewTopic('general');
      setNewTitle('');
      setCreating(false);
      setCollapsed(new Set());
    });
    return () => {
      cancelled = true;
    };
  }, [novelId]);

  /* ── Fetch conversations ── */
  const fetchConversations = useCallback(async () => {
    const requestNovelId = novelId;
    try {
      setLoading(true);
      const res = await fetch(`/api/novels/${novelId}/conversations`);
      if (!res.ok) throw new Error('Failed to load conversations');
      const data: Conversation[] = await res.json();
      if (activeNovelRef.current === requestNovelId) {
        setConversations(data);
        setError(null);
      }
    } catch (err) {
      if (activeNovelRef.current === requestNovelId) setError((err as Error).message);
    } finally {
      if (activeNovelRef.current === requestNovelId) setLoading(false);
    }
  }, [novelId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) fetchConversations();
    });
    return () => {
      cancelled = true;
    };
  }, [fetchConversations]);

  /* ── Group by topic ── */
  const grouped = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const topic of CONVERSATION_TOPICS) {
      map.set(topic, []);
    }
    for (const conv of conversations) {
      const list = map.get(conv.topic) ?? [];
      list.push(conv);
      map.set(conv.topic, list);
    }
    // Remove empty groups
    for (const [key, list] of map) {
      if (list.length === 0) map.delete(key);
    }
    return map;
  }, [conversations]);

  /* ── Handlers ── */
  const toggleGroup = (topic: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });
  };

  const handleCreate = async () => {
    const trimmed = newTitle.trim();
    if (!trimmed || creating) return;
    const requestNovelId = novelId;
    setCreating(true);
    setError(null);
    try {
      await onCreateConversation(newTopic, trimmed);
      if (activeNovelRef.current !== requestNovelId) return;
      setNewTitle('');
      setShowCreate(false);
      void fetchConversations();
    } catch (error) {
      if (activeNovelRef.current === requestNovelId) {
        setError(error instanceof Error ? error.message : 'Failed to create conversation');
      }
    } finally {
      if (activeNovelRef.current === requestNovelId) setCreating(false);
    }
  };

  /* ── Render ── */
  return (
    <div className="flex flex-col h-full" data-testid="conversation-list">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-book-border">
        <h3 className="text-sm font-semibold text-book-ink-primary">{t.conversations}</h3>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          data-testid="create-conversation-btn"
          onClick={() => setShowCreate(v => !v)}
          className="h-auto w-auto p-1 text-book-ink-muted hover:bg-book-bg-secondary hover:text-book-ink-secondary transition-colors"
          aria-label={t.conversationNew}
        >
          <Plus className="w-4 h-4" />
        </Button>
      </div>

      {/* Inline create form */}
      {showCreate && (
        <div className="px-3 py-2 border-b border-book-border space-y-2" data-testid="create-form">
          <Select value={newTopic} onValueChange={setNewTopic}>
            <SelectTrigger variant="boxed" className="h-auto w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONVERSATION_TOPICS.map(topic => (
                <SelectItem key={topic} value={topic}>
                  {t[topicMeta(topic).labelKey]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="text"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder={t.conversationTitlePlaceholder}
            maxLength={200}
            disabled={creating}
            variant="boxed"
            className="text-xs"
          />
          <Button
            variant="ink"
            size="sm"
            type="button"
            onClick={handleCreate}
            disabled={!newTitle.trim() || creating}
            className="w-full py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
          >
            {creating ? t.loading : t.conversationCreate}
          </Button>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {loading && conversations.length === 0 && (
          <p className="px-3 py-4 text-xs text-book-ink-muted text-center">{t.loading}...</p>
        )}

        {error && (
          <p className="px-3 py-4 text-xs text-book-danger text-center">{error}</p>
        )}

        {!loading && conversations.length === 0 && !error && (
          <Empty className="gap-2 border-0 p-0 px-3 py-8 md:p-0 md:px-3 md:py-8">
            <EmptyHeader className="gap-1">
              <EmptyMedia>
                <MessageSquare className="h-8 w-8 text-book-ink-muted" />
              </EmptyMedia>
              <EmptyTitle className="text-xs font-normal text-book-ink-muted">
                {t.conversationNoConversations}
              </EmptyTitle>
              <EmptyDescription className="text-xs text-book-ink-muted">
                {t.conversationNoConversationsHint}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        {Array.from(grouped.entries()).map(([topic, convs]) => {
          const isCollapsed = collapsed.has(topic);
          const meta = topicMeta(topic);
          return (
            <div key={topic} data-testid={`topic-group-${topic}`}>
              <Button
                type="button"
                variant="unstyled"
                size="unstyled"
                onClick={() => toggleGroup(topic)}
                className="flex items-center w-full px-3 py-1.5 text-xs font-medium text-book-ink-muted hover:bg-book-bg-secondary transition-colors"
              >
                {isCollapsed ? (
                  <ChevronRight className="w-3 h-3 mr-1 flex-shrink-0" />
                ) : (
                  <ChevronDown className="w-3 h-3 mr-1 flex-shrink-0" />
                )}
                <span className={meta.text}>{t[meta.labelKey]}</span>
                <span className="ml-auto text-2xs text-book-ink-muted">
                  {convs.length}
                </span>
              </Button>

              {/* Conversation items */}
              {!isCollapsed &&
                [...convs]
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .map(conv => (
                    <Button
                      key={conv.id}
                      type="button"
                      variant="unstyled"
                      size="unstyled"
                      onClick={() => onSelectConversation(conv.id)}
                      className={`flex flex-col w-full px-3 py-2 text-left transition-colors ${
                        conv.id === activeConvId
                          ? 'bg-book-bg-secondary border-l-4 border-book-gold'
                          : 'hover:bg-book-bg-secondary border-l-4 border-transparent'
                      }`}
                    >
                      {/* w-full + min-w-0 so the row fills the item (the Button
                          base centers content); the title gets min-w-0 so it
                          truncates instead of forcing the row wider than the
                          column and clipping the shrink-0 badge on the left. */}
                      <div className="flex w-full min-w-0 items-center gap-1.5">
                        <TopicBadge topic={conv.topic} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-book-ink-primary">
                          {conv.title}
                        </span>
                      </div>
                      <span className="text-2xs text-book-ink-muted mt-0.5">
                        {formatRelativeTime(conv.updatedAt, t as unknown as Record<string, string>)}
                      </span>
                    </Button>
                  ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
