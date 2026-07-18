'use client';

import type { ExportNovelLike, ExportChapterLike } from '@/lib/exporters/text';
import { buildNovelTxt } from '@/lib/exporters/text';
import { saveBlob } from '@/lib/download';
import type { PublishingConfig } from '@/lib/db-types';

export type ExportFormat = 'txt' | 'docx' | 'pdf' | 'epub';

/**
 * Optional knobs for formats that need more than novel+chapters. EPUB requires
 * the resolved publishing config (metadata, front matter, layout); the other
 * formats ignore it.
 */
export interface ExportNovelOptions {
  publishingConfig?: PublishingConfig;
}

export async function exportNovelClient(
  novel: ExportNovelLike,
  chapters: ExportChapterLike[],
  format: ExportFormat,
  options: ExportNovelOptions = {},
): Promise<Blob> {
  if (format === 'txt') {
    return new Blob([buildNovelTxt(novel, chapters)], {
      type: 'text/plain; charset=utf-8',
    });
  }

  if (format === 'docx') {
    // Webview path: toBlob (no Node Buffer global). Server route keeps toBuffer.
    const { buildNovelDocxBlob } = await import('@/lib/exporters/docx');
    return buildNovelDocxBlob(novel, chapters);
  }

  if (format === 'epub') {
    if (!options.publishingConfig) {
      throw new Error('EPUB export requires a resolved publishing config');
    }
    const { buildNovelEpubBuffer } = await import('@/lib/exporters/epub');
    // ExportNovelLike/ExportChapterLike are structurally compatible with the
    // publishing-html input shapes (title + chapterNumber/title/content).
    const buffer = await buildNovelEpubBuffer(novel, chapters, options.publishingConfig);
    return new Blob([buffer as BlobPart], { type: 'application/epub+zip' });
  }

  const { buildNovelPdfBuffer } = await import('@/lib/exporters/pdf');
  const buffer = await buildNovelPdfBuffer(novel, chapters);
  return new Blob([buffer as BlobPart], { type: 'application/pdf' });
}

/** Tauri-aware save (native dialog on desktop, anchor download in browser). */
export const downloadBlob = saveBlob;

/** Reveal a just-saved export in Finder/Explorer (desktop only; the Rust
 *  command rejects paths that did not come from `save_export_file`). */
async function revealSavedExport(path: string): Promise<void> {
  const { revealExportFile } = await import('@/lib/desktop-runtime');
  await revealExportFile(path);
}

/**
 * Shared post-export confirmation: on the desktop save-dialog path
 * (savedPath is a string) show a success toast with a "show in folder"
 * action; the browser anchor path resolves to undefined and stays silent.
 * Structurally typed so this lib module doesn't import component types.
 */
export function notifyExportSaved(
  savedPath: string | null | undefined,
  toast: (message: string, type: 'success', options: { action: { label: string; onClick: () => void } }) => void,
  t: { exportSavedToast: string; exportRevealAction: string },
): void {
  if (typeof savedPath !== 'string') return;
  toast(t.exportSavedToast, 'success', {
    action: { label: t.exportRevealAction, onClick: () => { void revealSavedExport(savedPath); } },
  });
}
