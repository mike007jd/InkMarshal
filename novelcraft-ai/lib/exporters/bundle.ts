import { strToU8, zipSync } from 'fflate';

import { buildChapterDocxBuffer, buildNovelDocxBuffer } from '@/lib/exporters/docx';
import { buildNovelEpubBuffer } from '@/lib/exporters/epub';
import { sanitizeFilenameSegment } from '@/lib/exporters/filename';
import { resolvePublishingConfig } from '@/lib/exporters/publishing-presets';
import { uniqueFilename } from '@/lib/vault/filename';
import {
  buildChapterTxt,
  buildNovelTxt,
  type ExportChapterLike,
  type ExportNovelLike,
} from '@/lib/exporters/text';
import { CJKNotSupportedError } from '@/lib/exporters/pdf';

interface SubmissionBundleInput {
  novel: ExportNovelLike & {
    stage?: string;
  };
  chapters: ExportChapterLike[];
}

export async function buildSubmissionBundle(
  input: SubmissionBundleInput
): Promise<Uint8Array> {
  const { novel, chapters } = input;

  if (chapters.length === 0) {
    throw new Error('At least one chapter is required to build an export ZIP');
  }

  const safeNovelTitle = sanitizeFilenameSegment(novel.title, 'Untitled Novel', 80);
  let pdfIncluded = true;
  const pdfEntry: Record<string, Uint8Array> = {};
  const publishingConfig = resolvePublishingConfig({ publishing: undefined }, 'submission');

  try {
    const { buildNovelPdfBuffer } = await import('@/lib/exporters/pdf');
    pdfEntry[`${safeNovelTitle}.pdf`] = await buildNovelPdfBuffer(novel, chapters);
  } catch (err) {
    // Discriminate by instanceof, not by .name string — a minified/mangled
    // build would rename the class and let a real PDF failure be re-thrown,
    // aborting the entire bundle (docx + txt + chapter files) instead of just
    // skipping PDF.
    if (!(err instanceof CJKNotSupportedError)) throw err;
    pdfIncluded = false;
  }

  const files = {
    'README.txt': strToU8(buildNotes(novel, chapters.length, pdfIncluded)),
    'Full Manuscript': {
      [`${safeNovelTitle}.txt`]: strToU8(buildNovelTxt(novel, chapters)),
      [`${safeNovelTitle}.docx`]: await buildNovelDocxBuffer(novel, chapters),
      [`${safeNovelTitle}.epub`]: await buildNovelEpubBuffer(
        novel,
        chapters,
        publishingConfig,
      ),
      ...pdfEntry,
    },
    'Chapters TXT': {} as Record<string, Uint8Array>,
    'Chapters DOCX': {} as Record<string, Uint8Array>,
  };

  for (const chapter of chapters) {
    const chapterBaseName = buildChapterBaseName(chapter.chapterNumber, chapter.title);
    files['Chapters TXT'][
      uniqueFilename(chapterBaseName, 'txt', new Set(Object.keys(files['Chapters TXT'])))
    ] = strToU8(buildChapterTxt(chapter));
    files['Chapters DOCX'][
      uniqueFilename(chapterBaseName, 'docx', new Set(Object.keys(files['Chapters DOCX'])))
    ] = await buildChapterDocxBuffer(chapter);
  }

  return zipSync(files, {
    level: 6,
  });
}

function buildNotes(
  novel: SubmissionBundleInput['novel'],
  chapterCount: number,
  pdfIncluded: boolean
): string {
  const completed = novel.stage === 'completed';

  return [
    `Novel title: ${novel.title || 'Untitled Novel'}`,
    `Chapters exported: ${chapterCount}`,
    `Exported at: ${new Date().toISOString()}`,
    `Draft status: ${completed ? 'finished' : 'in progress'}`,
    completed
      ? 'This export ZIP contains the full current manuscript.'
      : 'This export ZIP contains generated chapters only.',
    ...(pdfIncluded
      ? []
      : [
          'Note: PDF was skipped because this manuscript contains characters outside the bundled PDF fonts. Use EPUB, DOCX, or TXT.',
        ]),
    '',
  ].join('\n');
}

function buildChapterBaseName(chapterNumber: number, title: string): string {
  return `Chapter ${String(chapterNumber).padStart(4, '0')} - ${sanitizeFilenameSegment(
    title,
    'Untitled Chapter',
    80
  )}`;
}
