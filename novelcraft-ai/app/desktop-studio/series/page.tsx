'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Layers, Plus, ChevronRight } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSeriesList, createSeries } from '@/app/actions/series';
import type { Series } from '@/lib/db/queries-series';

// Desktop-only series index (W3-3). The /desktop-studio layout owns the shell
// chrome; this is the list/create landing that deep-links into each series
// workspace at /desktop-studio/series/[id]. Self-contained: fetches via server
// actions against local SQLite. Copy is inlined per-locale so the shared i18n
// bundle stays untouched (only the sidebar nav label lives there).
const COPY = {
  en: {
    title: 'Series',
    subtitle: 'Share characters, places, rules and timelines across a series of novels.',
    create: 'New series',
    empty: 'No series yet. Create one to share worldbuilding across novels.',
    namePlaceholder: 'Series title',
    open: 'Open',
  },
  'zh-CN': {
    title: '系列',
    subtitle: '在同系列多部小说间共享角色 / 地点 / 规则 / 时间线。',
    create: '新建系列',
    empty: '还没有系列。创建一个,在多部小说间共享世界观。',
    namePlaceholder: '系列标题',
    open: '打开',
  },
  'zh-TW': {
    title: '系列',
    subtitle: '在同系列多部小說間共享角色 / 地點 / 規則 / 時間線。',
    create: '新建系列',
    empty: '還沒有系列。建立一個,在多部小說間共享世界觀。',
    namePlaceholder: '系列標題',
    open: '打開',
  },
} as const;

export default function DesktopStudioSeriesIndexPage() {
  const { locale } = useLanguage();
  const c = COPY[(locale as keyof typeof COPY) in COPY ? (locale as keyof typeof COPY) : 'en'];
  const router = useRouter();
  const [series, setSeries] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSeries(await getSeriesList());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer so the initial fetch's setState doesn't run synchronously inside the
    // effect body (cascading-render lint rule); mirrors series-workspace.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const handleCreate = useCallback(async () => {
    const title = draftTitle.trim();
    if (creating || !title) return;
    setCreating(true);
    try {
      const created = await createSeries({ title });
      router.push(`/desktop-studio/series/${created.id}`);
    } finally {
      setCreating(false);
    }
  }, [creating, draftTitle, router]);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
      <header className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 font-serif text-xl font-bold text-book-ink-primary">
          <Layers className="h-5 w-5 text-book-gold" />
          {c.title}
        </h1>
        <p className="text-sm text-book-ink-secondary">{c.subtitle}</p>
      </header>

      <div className="flex items-center gap-2">
        <Input
          value={draftTitle}
          onChange={e => setDraftTitle(e.target.value)}
          placeholder={c.namePlaceholder}
          onKeyDown={e => {
            if (e.key === 'Enter') void handleCreate();
          }}
          className="max-w-xs"
        />
        <Button onClick={() => void handleCreate()} disabled={creating || !draftTitle.trim()}>
          <Plus className="h-4 w-4" />
          {c.create}
        </Button>
      </div>

      {!loading && series.length === 0 ? (
        <p className="rounded-lg border border-dashed border-book-border bg-book-bg-card px-4 py-10 text-center text-sm text-book-ink-muted">
          {c.empty}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {series.map(s => (
            <li key={s.id}>
              <Button
                variant="ghost"
                asChild
                className="group/row flex h-auto w-full items-center justify-between gap-3 border border-book-border bg-book-bg-card px-4 py-3 text-left transition-colors hover:border-book-gold/40 hover:bg-book-bg-secondary"
              >
                <Link href={`/desktop-studio/series/${s.id}`}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-book-ink-primary">{s.title}</span>
                    {s.description ? (
                      <span className="truncate text-xs text-book-ink-secondary">{s.description}</span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-book-ink-secondary transition-colors group-hover/row:text-book-gold">
                    {c.open}
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  </span>
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
