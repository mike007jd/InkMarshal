'use client';

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { exportFilenameBase } from '@/lib/exporters/filename';
import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';

interface ChapterDownloadMenuProps {
  chapterTitle: string;
  chapterContent: string;
  chapterNumber: number;
}

export function ChapterDownloadMenu({
  chapterTitle,
  chapterContent,
  chapterNumber,
}: ChapterDownloadMenuProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const chapter = { title: chapterTitle, content: chapterContent, chapterNumber };
  const safeName = exportFilenameBase(chapterTitle);

  // downloadBlob rejects on disk-full / permission-denied / Tauri invoke
  // errors; without this the menu closed as if it had succeeded.
  const runExport = async (format: 'txt' | 'docx', task: () => Promise<void>) => {
    try {
      await task();
    } catch (error) {
      toast(error instanceof Error ? error.message : t.errorExportFailed, 'error', {
        action: { label: t.toastRetry, onClick: () => { void runExport(format, task); } },
      });
    }
  };

  const handleTxt = () => runExport('txt', async () => {
    const { downloadBlob, notifyExportSaved } = await import('@/lib/export-client');
    const { buildChapterTxt } = await import('@/lib/exporters/text');
    const text = buildChapterTxt(chapter);
    const savedPath = await downloadBlob(new Blob([text], { type: 'text/plain; charset=utf-8' }), `${safeName}.txt`);
    notifyExportSaved(savedPath, toast, t);
  });

  const handleDocx = () => runExport('docx', async () => {
    const { downloadBlob, notifyExportSaved } = await import('@/lib/export-client');
    // Webview path: Blob builder (toBlob) — toBuffer needs the absent Node Buffer.
    const { buildChapterDocxBlob } = await import('@/lib/exporters/docx');
    const blob = await buildChapterDocxBlob(chapter);
    const savedPath = await downloadBlob(blob, `${safeName}.docx`);
    notifyExportSaved(savedPath, toast, t);
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="unstyled"
          onClick={(event) => event.stopPropagation()}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-book-ink-muted transition hover:bg-book-border hover:text-book-ink-secondary"
          title={t.exportChapter}
          aria-label={t.exportChapter}
        >
          <Download className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[110px]">
        <DropdownMenuGroup>
          <DropdownMenuItem
            className="text-xs text-book-ink-secondary"
            onSelect={() => { void handleTxt(); }}
          >
            TXT
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-xs text-book-ink-secondary"
            onSelect={() => { void handleDocx(); }}
          >
            DOCX
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
