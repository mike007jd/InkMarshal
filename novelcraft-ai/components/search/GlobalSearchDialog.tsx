'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useManuscriptSearch } from '@/lib/search/use-manuscript-search';
import {
  MAX_QUERY_LENGTH,
  type SearchInputChapter,
  type SearchResult,
} from '@/lib/search/manuscript-search';
import { findNormalizedSearchMatch, normalizeSearchText } from '@/lib/search/normalized-text';
import type { NovelListScope, SearchScope } from './GlobalSearchProvider';

const DEBOUNCE_MS = 150;

interface GlobalSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: SearchScope | null;
  novelListScope: NovelListScope | null;
}

interface NovelListResultRow {
  novelId: string;
  title: string;
  /** match offset inside the normalized title for ordering */
  offset: number;
  highlight: { start: number; end: number };
}

interface LibraryChapterResult {
  novelId: string;
  novelTitle: string;
  result: SearchResult;
}

export function GlobalSearchDialog({ open, onOpenChange, scope, novelListScope }: GlobalSearchDialogProps) {
  const { t } = useLanguage();
  const [query, setQuery] = useState('');
  const [manuscriptResults, setManuscriptResults] = useState<SearchResult[]>([]);
  const [novelResults, setNovelResults] = useState<NovelListResultRow[]>([]);
  const [libraryChapterResults, setLibraryChapterResults] = useState<LibraryChapterResult[]>([]);
  const [mode, setMode] = useState<'current' | 'all'>(
    scope?.kind === 'manuscript' ? 'current' : 'all',
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef('');
  const searchSeqRef = useRef(0);
  const libraryChapterCacheRef = useRef(new Map<string, SearchInputChapter[]>());

  const { search } = useManuscriptSearch();

  // Clear results when dialog closes; refocus when reopening
  useEffect(() => {
    if (!open) {
      searchSeqRef.current += 1;
      libraryChapterCacheRef.current.clear();
      // Defer to microtask so this doesn't count as a sync setState during
      // the effect body (react-hooks/set-state-in-effect).
      queueMicrotask(() => {
        setQuery('');
        setManuscriptResults([]);
        setNovelResults([]);
        setLibraryChapterResults([]);
        lastQueryRef.current = '';
      });
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    } else {
      queueMicrotask(() => setMode(scope?.kind === 'manuscript' ? 'current' : 'all'));
      // Radix focuses the first focusable element; explicit focus is safer in
      // case the autoFocus race differs across browsers.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, scope?.kind]);

  useEffect(() => {
    let cancelled = false;
    const seq = ++searchSeqRef.current;
    queueMicrotask(() => {
      if (cancelled || searchSeqRef.current !== seq) return;
      setManuscriptResults([]);
      setNovelResults([]);
      setLibraryChapterResults([]);
      lastQueryRef.current = '';
    });
    return () => {
      cancelled = true;
    };
  }, [scope?.id]);

  // Debounced search
  useEffect(() => {
    const seq = ++searchSeqRef.current;
    if (!open || !scope) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) {
      // Empty query → schedule the reset via microtask to avoid synchronous
      // setState during the effect body. Same effect runs on dialog reopen.
      queueMicrotask(() => {
        if (searchSeqRef.current !== seq) return;
        setManuscriptResults([]);
        setNovelResults([]);
        setLibraryChapterResults([]);
        lastQueryRef.current = '';
      });
      return;
    }
    if (q.length > MAX_QUERY_LENGTH) {
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const requestScopeId = scope.id;
      lastQueryRef.current = q;
      if (mode === 'current' && scope.kind === 'manuscript') {
        const results = await search(scope.chapters as SearchInputChapter[], q);
        if (
          lastQueryRef.current === q &&
          searchSeqRef.current === seq &&
          scope.id === requestScopeId
        ) {
          setManuscriptResults(results);
          setNovelResults([]);
          setLibraryChapterResults([]);
        }
      } else {
        const libraryScope = novelListScope ?? (scope.kind === 'novel-list' ? scope : null);
        if (!libraryScope) return;
        const rows: NovelListResultRow[] = [];
        for (const item of libraryScope.items) {
          const match = findNormalizedSearchMatch(item.title, q);
          if (match) {
            rows.push({
              novelId: item.novelId,
              title: item.title,
              offset: match.normalizedOffset,
              highlight: {
                start: match.range.offset,
                end: match.range.offset + match.range.length,
              },
            });
          }
        }
        rows.sort((a, b) => a.offset - b.offset);
        const chapterSets = await Promise.all(libraryScope.items.map(async item => {
          const cached = libraryChapterCacheRef.current.get(item.novelId);
          if (cached) return { item, chapters: cached };
          const chapters = await fetch(`/api/novels/${item.novelId}/chapters`)
            .then(async response => response.ok ? await response.json() as SearchInputChapter[] : [])
            .catch(() => [] as SearchInputChapter[]);
          libraryChapterCacheRef.current.set(item.novelId, chapters);
          return { item, chapters };
        }));
        const matches = await Promise.all(chapterSets.map(async ({ item, chapters }) => ({
          item,
          results: await search(chapters, q),
        })));
        const chapterRows = matches
          .flatMap(({ item, results }) => results.map(result => ({
            novelId: item.novelId,
            novelTitle: item.title,
            result,
          })))
          .sort((a, b) => b.result.score - a.result.score)
          .slice(0, 50);
        if (searchSeqRef.current === seq && scope.id === requestScopeId) {
          setNovelResults(rows.slice(0, 50));
          setManuscriptResults([]);
          setLibraryChapterResults(chapterRows);
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, scope, search, mode, novelListScope]);

  const resultCount = mode === 'current' && scope?.kind === 'manuscript'
    ? manuscriptResults.length
    : novelResults.length + libraryChapterResults.length;
  // Singular vs plural so a single hit doesn't read "1 results".
  const resultCountLabel = resultCount === 1
    ? t.searchResultCountOne
    : t.searchResultCount.replace('{n}', String(resultCount));
  const hasChapters = mode === 'current' && scope?.kind === 'manuscript'
    ? scope.chapters.length > 0
    : Boolean(novelListScope?.items.length || scope?.kind === 'novel-list' && scope.items.length);

  const handleManuscriptSelect = (result: SearchResult) => {
    if (!scope) return;
    if (scope.kind !== 'manuscript') return;
    onOpenChange(false);
    // Defer so the dialog can finish unmounting before we drive scroll/select.
    setTimeout(() => scope.onJump(result.chapterNumber, result.offset), 0);
  };

  const handleNovelSelect = (result: NovelListResultRow) => {
    const libraryScope = novelListScope ?? (scope?.kind === 'novel-list' ? scope : null);
    if (!libraryScope) return;
    onOpenChange(false);
    setTimeout(() => libraryScope.onJump(result.novelId), 0);
  };

  const handleLibraryChapterSelect = (row: LibraryChapterResult) => {
    if (!novelListScope) return;
    onOpenChange(false);
    setTimeout(() => novelListScope.onJump(
      row.novelId,
      row.result.chapterNumber,
      row.result.offset,
    ), 0);
  };

  const scopeLabel = useMemo(() => {
    if (!scope) return '';
    return mode === 'current' && scope.kind === 'manuscript'
      ? t.searchScopeManuscript
      : t.searchScopeAllNovels;
  }, [mode, scope, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={scopeLabel}
        className="top-[18%] flex max-w-xl translate-y-0 flex-col gap-0 overflow-hidden p-0 [&>button.absolute]:hidden"
      >
        <DialogTitle className="sr-only">{scopeLabel}</DialogTitle>

        <Command shouldFilter={false} loop className="rounded-sharp">
          {scope?.kind === 'manuscript' && novelListScope && (
            <div className="flex gap-1 border-b border-book-border bg-book-bg-secondary/40 p-2">
              <Button
                type="button"
                size="sm"
                variant={mode === 'current' ? 'outline' : 'ghost'}
                onClick={() => setMode('current')}
                className="h-7"
              >
                {t.searchCurrentNovel}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === 'all' ? 'outline' : 'ghost'}
                onClick={() => setMode('all')}
                className="h-7"
              >
                {t.searchAllNovels}
              </Button>
            </div>
          )}
          <CommandInput
            ref={inputRef}
            value={query}
            maxLength={MAX_QUERY_LENGTH}
            onValueChange={value => setQuery(value.slice(0, MAX_QUERY_LENGTH))}
            placeholder={t.searchPlaceholder}
            aria-label={t.searchPlaceholder}
            wrapperClassName="h-auto border-book-border px-4 py-3"
            className="h-auto py-0 text-book-ink-primary placeholder:text-book-ink-muted"
            trailing={
              <span className="shrink-0 text-2xs uppercase tracking-widest text-book-ink-muted">
                {scopeLabel}
              </span>
            }
          />

          <CommandList className="max-h-[420px] min-h-10 p-0">
            {!hasChapters ? (
              <CommandEmpty className="px-4 py-8 font-serif italic text-book-ink-muted">
                {t.searchEmpty}
              </CommandEmpty>
            ) : !query.trim() ? (
              <CommandEmpty className="px-4 py-8 font-serif italic text-book-ink-muted">
                {t.searchShortcutHint}
              </CommandEmpty>
            ) : resultCount === 0 ? (
              <CommandEmpty className="px-4 py-8 font-serif italic text-book-ink-muted">
                {t.searchNoResults}
              </CommandEmpty>
            ) : mode === 'current' && scope?.kind === 'manuscript' ? (
              <CommandGroup
                heading={resultCountLabel}
                className="p-0 [&_[cmdk-group-heading]]:border-b [&_[cmdk-group-heading]]:border-book-border [&_[cmdk-group-heading]]:bg-book-bg-secondary/40 [&_[cmdk-group-heading]]:px-4"
              >
                {manuscriptResults.map(r => (
                  <ManuscriptResultRow
                    key={`${r.chapterNumber}-${r.field}-${r.offset}`}
                    result={r}
                    chapterLabel={t.manuscriptChapter.replace('{num}', String(r.chapterNumber).padStart(2, '0'))}
                    onSelect={() => handleManuscriptSelect(r)}
                  />
                ))}
              </CommandGroup>
            ) : (
              <CommandGroup
                heading={resultCountLabel}
                className="p-0 [&_[cmdk-group-heading]]:border-b [&_[cmdk-group-heading]]:border-book-border [&_[cmdk-group-heading]]:bg-book-bg-secondary/40 [&_[cmdk-group-heading]]:px-4"
              >
                {novelResults.map(r => (
                  <NovelListResultRowView
                    key={r.novelId}
                    result={r}
                    query={query.trim()}
                    onSelect={() => handleNovelSelect(r)}
                  />
                ))}
                {libraryChapterResults.map(row => (
                  <ManuscriptResultRow
                    key={`${row.novelId}-${row.result.chapterNumber}-${row.result.field}-${row.result.offset}`}
                    result={row.result}
                    chapterLabel={t.manuscriptChapter.replace('{num}', String(row.result.chapterNumber).padStart(2, '0'))}
                    bookLabel={row.novelTitle}
                    onSelect={() => handleLibraryChapterSelect(row)}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>

        <div className="flex items-center justify-between border-t border-book-border bg-book-bg-secondary/50 px-4 py-2 text-2xs text-book-ink-muted">
          <span>↑↓ · Enter · Esc</span>
          <DialogClose asChild>
            <Button
              type="button"
              variant="unstyled"
              size="unstyled"
              className="text-2xs text-book-ink-muted hover:text-book-ink-primary"
            >
              {t.searchClose}
            </Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ManuscriptResultRow({
  result,
  chapterLabel,
  onSelect,
  bookLabel,
}: {
  result: SearchResult;
  chapterLabel: string;
  onSelect: () => void;
  bookLabel?: string;
}) {
  const before = result.snippet.slice(0, result.highlight.start);
  const match = result.snippet.slice(result.highlight.start, result.highlight.end);
  const after = result.snippet.slice(result.highlight.end);

  return (
    <CommandItem
      value={`manuscript-${result.chapterNumber}-${result.field}-${result.offset}`}
      onSelect={onSelect}
      className="flex flex-col items-start gap-1 rounded-none border-b border-book-border/50 px-4 py-2.5 text-left data-[selected=true]:bg-book-bg-secondary data-[selected=true]:text-book-ink-primary"
    >
      <div className="flex items-baseline gap-2 text-2xs uppercase tracking-label text-book-gold">
        {bookLabel && (
          <span className="max-w-40 truncate font-sans normal-case tracking-normal text-book-ink-secondary">
            {bookLabel}
          </span>
        )}
        <span>{chapterLabel}</span>
        <span className="truncate font-sans normal-case tracking-normal text-book-ink-muted">
          {result.chapterTitle}
        </span>
        {result.field === 'title' && (
          <span className="ml-auto rounded bg-book-gold/20 px-1.5 py-0.5 font-sans text-2xs uppercase tracking-widest text-book-gold-dark">
            title
          </span>
        )}
      </div>
      <div className="font-serif text-sm-tight leading-snug text-book-ink-secondary">
        {before}
        <mark className="bg-book-gold/30 text-book-ink-primary">{match}</mark>
        {after}
      </div>
    </CommandItem>
  );
}

function NovelListResultRowView({
  result,
  query,
  onSelect,
}: {
  result: NovelListResultRow;
  query: string;
  onSelect: () => void;
}) {
  const normalizedQuery = normalizeSearchText(query);
  const boundedStart = Math.max(0, Math.min(result.title.length, result.highlight.start));
  const boundedEnd = Math.max(boundedStart, Math.min(result.title.length, result.highlight.end));
  let before = result.title;
  let match = '';
  let after = '';
  if (normalizedQuery && boundedEnd > boundedStart) {
    before = result.title.slice(0, boundedStart);
    match = result.title.slice(boundedStart, boundedEnd);
    after = result.title.slice(boundedEnd);
  }

  return (
    <CommandItem
      value={`novel-${result.novelId}`}
      onSelect={onSelect}
      className="flex w-full items-center gap-2 rounded-none border-b border-book-border/50 px-4 py-2.5 text-left text-sm data-[selected=true]:bg-book-bg-secondary data-[selected=true]:text-book-ink-primary"
    >
      <span className="font-serif text-book-ink-primary">
        {before}
        {match && <mark className="bg-book-gold/30 text-book-ink-primary">{match}</mark>}
        {after}
      </span>
    </CommandItem>
  );
}
