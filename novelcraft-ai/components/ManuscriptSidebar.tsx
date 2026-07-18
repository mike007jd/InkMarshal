'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download, PenLine } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { exportFilenameBase } from '@/lib/exporters/filename';
import { ChapterDownloadMenu } from '@/components/ChapterDownloadMenu';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface SidebarChapter {
  id?: string;
  chapterNumber: number;
  title: string;
  content: string;
  wordCount: number;
}

interface ManuscriptSidebarProps {
  title: string;
  genre: string;
  storySummary?: string;
  characterSummary?: string;
  arcSummary?: string;
  progress: number;
  chapters: SidebarChapter[];
  activeChapter: number | null;
  isWritingLive: boolean;
  viewMode: 'reading' | 'editing';
  liveChapterNumber?: number;
  onModeChange: (mode: 'reading' | 'editing') => void;
  onChapterSelect: (chapterNumber: number) => void;
}

export function ManuscriptSidebar({
  title,
  genre,
  storySummary,
  characterSummary,
  arcSummary,
  progress,
  chapters,
  activeChapter,
  isWritingLive,
  viewMode,
  liveChapterNumber,
  onModeChange,
  onChapterSelect,
}: ManuscriptSidebarProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [exporting, setExporting] = useState<string | null>(null);
  const chapterRefs = useRef(new Map<number, HTMLButtonElement>());

  const safeName = exportFilenameBase(title);

  useEffect(() => {
    if (activeChapter == null) return;
    const frame = requestAnimationFrame(() => {
      chapterRefs.current.get(activeChapter)?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeChapter]);

  // PDF export embeds the bundled Noto Serif SC face for CJK manuscripts.
  // Scripts the bundled fonts can't cover (Arabic, Hebrew, …) throw
  // CJKNotSupportedError at build time and surface the EPUB/DOCX/TXT guidance
  // toast below.
  const exportFormats: Array<'txt' | 'docx' | 'pdf' | 'epub'> = ['epub', 'txt', 'docx', 'pdf'];

  const handleExportAll = async (format: 'txt' | 'docx' | 'pdf' | 'epub') => {
    if (exporting) return;
    setExporting(format);
    try {
      const { exportNovelClient, downloadBlob, notifyExportSaved } = await import('@/lib/export-client');
      const novel = {
        title,
        genre,
        storySummary: storySummary ?? '',
        characterSummary: characterSummary ?? '',
        arcSummary: arcSummary ?? '',
      };
      const options =
        format === 'epub'
          ? {
              publishingConfig: (await import('@/lib/exporters/publishing-presets'))
                .resolvePublishingConfig({ publishing: undefined }, 'submission'),
            }
          : undefined;
      const blob = await exportNovelClient(novel, chapters, format, options);
      notifyExportSaved(await downloadBlob(blob, `${safeName}.${format}`), toast, t);
    } catch (error) {
      const isPdfFontCoverageError = error instanceof Error && error.name === 'CJKNotSupportedError';
      const message = isPdfFontCoverageError
        ? t.bundlePdfFontUnsupported
        : error instanceof Error
          ? error.message
          : t.errorExportFailed;
      toast(message, 'error', {
        action: { label: t.toastRetry, onClick: () => { void handleExportAll(format); } },
      });
    } finally {
      setExporting(null);
    }
  };

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-book-border bg-book-bg-sidebar/90 shadow-sm backdrop-blur">
      {/* Mode toggle */}
      <ToggleGroup
        type="single"
        value={viewMode}
        onValueChange={(next) => {
          if (next === 'reading' || next === 'editing') onModeChange(next);
        }}
        className="flex w-full shrink-0 gap-1 border-b border-book-border p-2"
      >
        <ToggleGroupItem
          value="reading"
          className="h-auto min-w-0 flex-1 rounded-md px-3 py-1.5 text-xs font-semibold text-book-ink-secondary transition hover:bg-book-bg-secondary hover:text-book-ink-secondary data-[state=on]:bg-book-gold data-[state=on]:text-book-on-gold data-[state=on]:shadow-sm"
        >
          {t.readingMode}
        </ToggleGroupItem>
        <ToggleGroupItem
          value="editing"
          disabled={isWritingLive}
          title={isWritingLive ? t.editingDisabledWriting : undefined}
          className="h-auto min-w-0 flex-1 rounded-md px-3 py-1.5 text-xs font-semibold text-book-ink-secondary transition hover:bg-book-bg-secondary hover:text-book-ink-secondary data-[state=on]:bg-book-gold data-[state=on]:text-book-on-gold data-[state=on]:shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t.editingMode}
        </ToggleGroupItem>
      </ToggleGroup>

      {/* Title, genre, status */}
      <div className="shrink-0 border-b border-book-border px-4 py-3">
        <h2 className="truncate font-serif text-base leading-tight text-book-ink-primary">
          {title}
        </h2>
        <div className="mt-1 flex items-center gap-1.5 text-xs-tight text-book-ink-secondary">
          <span className="truncate">{genre}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="shrink-0 border-b border-book-border px-4 py-3">
        <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-book-ink-secondary">
          <span>{t.manuscriptProgress}</span>
          <span>{progress}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-book-border">
          <div
            className="motion-essential h-full rounded-full book-progress-bar transition-progress"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Chapter list */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="shrink-0 px-4 pb-1 pt-3 text-xs font-semibold text-book-ink-secondary">
          {t.manuscriptChapters}
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {chapters.length === 0 ? (
            <p className="px-1 py-2 text-xs text-book-ink-secondary">
              {t.manuscriptEmpty}
            </p>
          ) : (
            chapters.map((ch) => {
              const isActive = activeChapter === ch.chapterNumber;
              const isLive = ch.chapterNumber === liveChapterNumber;

              return (
                <div
                  key={ch.id ?? `ch-${ch.chapterNumber}`}
                  className={[
                    'group relative mb-1 flex items-stretch rounded-lg border text-xs transition',
                    isActive
                      ? 'border-book-gold bg-book-bg-secondary'
                      : 'border-transparent hover:border-book-border hover:bg-book-bg-secondary',
                    isLive ? 'opacity-75' : '',
                  ].join(' ')}
                >
                  <Button
                    ref={(node) => {
                      if (node) chapterRefs.current.set(ch.chapterNumber, node);
                      else chapterRefs.current.delete(ch.chapterNumber);
                    }}
                    type="button"
                    variant="unstyled"
                    size="unstyled"
                    title={ch.title}
                    aria-current={isActive ? 'true' : undefined}
                    className="min-w-0 flex-1 items-start justify-start px-2.5 py-2 pr-14 text-left focus-visible:ring-inset"
                    onClick={() => onChapterSelect(ch.chapterNumber)}
                  >
                    {/* Title block — chapter number + truncated 2-line title + meta */}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span className="shrink-0 text-xs-tight font-semibold text-book-gold-dark">
                          {t.manuscriptChapter.replace('{num}', String(ch.chapterNumber).padStart(2, '0'))}
                        </span>
                        <span className="shrink-0 text-2xs text-book-ink-muted">
                          · {ch.wordCount}
                        </span>
                      </div>
                      <div
                        className={[
                          'text-2xs leading-snug line-clamp-2 break-words',
                          isActive ? 'font-semibold text-book-ink-primary' : 'text-book-ink-secondary',
                        ].join(' ')}
                      >
                        {ch.title}
                      </div>
                    </div>
                  </Button>

                  {/* Right rail: live pen / download menu / chevron */}
                  <div
                    className={`absolute right-2 top-2 flex items-center gap-1 transition-opacity ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}
                  >
                    {isLive ? (
                      <PenLine className="h-3 w-3 text-book-stage-writing" />
                    ) : (
                      <ChapterDownloadMenu
                        chapterTitle={ch.title}
                        chapterContent={ch.content}
                        chapterNumber={ch.chapterNumber}
                      />
                    )}
                    <ChevronRight
                      className={[
                        'h-3 w-3 transition-transform text-book-ink-muted',
                        isActive ? 'translate-x-0.5 text-book-gold' : '',
                      ].join(' ')}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Export is intentionally one on-demand menu: the chapter list stays
          a navigation surface until the user expresses export intent. */}
      <div className="shrink-0 border-t border-book-border px-4 py-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="book"
              type="button"
              disabled={!!exporting || chapters.length === 0}
              className="h-auto w-full justify-between px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="inline-flex items-center gap-2">
                <Download className="h-3.5 w-3.5" />
                {exporting ? t.exporting : t.exportNovel}
              </span>
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[12rem]">
            <DropdownMenuGroup>
              {exportFormats.map((fmt) => (
                <DropdownMenuItem
                  key={fmt}
                  disabled={!!exporting}
                  onSelect={() => { void handleExportAll(fmt); }}
                  className="justify-between text-xs"
                >
                  <span>{t.exportNovel}</span>
                  <span className="font-semibold uppercase text-book-ink-muted">{fmt}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
