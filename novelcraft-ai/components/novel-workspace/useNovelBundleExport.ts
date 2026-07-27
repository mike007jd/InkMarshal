'use client';

import { useCallback, useEffect, useRef } from 'react';

import { useLanguage } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { requestManuscriptFlush } from '@/lib/desktop-shell-bus';
import { parseDownloadFilename, saveBlob } from '@/lib/download';

export function useNovelBundleExport(novelId: string, novelTitle?: string) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const activeNovelIdRef = useRef(novelId);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    activeNovelIdRef.current = novelId;
    abortRef.current?.abort();
    abortRef.current = null;
  }, [novelId]);

  const downloadBundle = useCallback(async () => {
    const requestNovelId = novelId;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    try {
      const saveOutcome = await requestManuscriptFlush();
      if (!saveOutcome.ok) {
        const where = saveOutcome.chapterNumber
          ? ` (Ch.${saveOutcome.chapterNumber}${saveOutcome.title ? ` — ${saveOutcome.title}` : ''})`
          : '';
        throw new Error(`${t.editorSaveError}${where}`);
      }
      const response = await fetch(`/api/novels/${requestNovelId}/export-bundle`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as {
          code?: string;
          error?: string;
          sizeMiB?: number;
          maxMiB?: number;
        };
        const localized =
          data.code === 'NO_CHAPTERS' ? t.bundleNoChapters
          : data.code === 'CJK_NOT_SUPPORTED' ? t.bundlePdfFontUnsupported
          : data.code === 'BUNDLE_TOO_LARGE'
            ? t.bundleTooLarge
                .replace('{size}', String(data.sizeMiB ?? '?'))
                .replace('{max}', String(data.maxMiB ?? '?'))
            : (data.error || t.bundleDownloadFailed);
        throw new Error(localized);
      }
      const bundle = await response.blob();
      if (activeNovelIdRef.current !== requestNovelId) return;
      const filename = parseDownloadFilename(
        response.headers.get('content-disposition'),
        `${novelTitle || 'novel'}-bundle.zip`,
      );
      const { notifyExportSaved } = await import('@/lib/export-client');
      const savedPath = await saveBlob(bundle, filename);
      notifyExportSaved(savedPath, toast, t);
      if (typeof savedPath === 'string') {
        const { recordExportActivity } = await import('@/app/actions/activity');
        void recordExportActivity(novelId, 'bundle');
      }
    } catch (error) {
      if (controller.signal.aborted || activeNovelIdRef.current !== requestNovelId) return;
      console.error('Bundle download failed:', error);
      toast(error instanceof Error ? error.message : t.bundleDownloadFailed);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [novelId, novelTitle, t, toast]);

  useEffect(() => {
    const handler = () => {
      void downloadBundle();
    };
    window.addEventListener('inkmarshal:export-bundle', handler);
    return () => window.removeEventListener('inkmarshal:export-bundle', handler);
  }, [downloadBundle]);

  return downloadBundle;
}
