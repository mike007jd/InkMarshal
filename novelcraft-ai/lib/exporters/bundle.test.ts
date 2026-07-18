import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import { buildSubmissionBundle } from '@/lib/exporters/bundle';
import { CJKNotSupportedError } from '@/lib/exporters/pdf';

describe('submission bundle filename boundaries', () => {
  it('keeps user titles out of unsafe zip entry names', async () => {
    const bundle = await buildSubmissionBundle({
      novel: {
        title: '..',
        genre: 'fantasy',
        storySummary: '',
        characterSummary: '',
        arcSummary: '',
        stage: 'completed',
      },
      chapters: [
        {
          chapterNumber: 1,
          title: '.././Bad\\Chapter',
          content: 'plain ascii chapter content',
        },
      ],
    });

    const entryNames = Object.keys(unzipSync(bundle));

    expect(entryNames).toContain('Full Manuscript/Untitled Novel.txt');
    expect(entryNames).toContain('Full Manuscript/Untitled Novel.docx');
    expect(entryNames).toContain('Full Manuscript/Untitled Novel.epub');
    expect(entryNames).toContain('Chapters TXT/Chapter 0001 - Bad Chapter.txt');
    expect(entryNames).toContain('Chapters DOCX/Chapter 0001 - Bad Chapter.docx');

    for (const name of entryNames) {
      expect(name.length).toBeLessThanOrEqual(140);
      expect(name).not.toMatch(/(^|\/)\.{1,2}(\/|$)/);
      expect(name).not.toMatch(/[<>:"\\|?*\u0000-\u001F\u007F]/);
    }
  });

  it('keeps duplicate chapter filenames instead of overwriting zip entries', async () => {
    const bundle = await buildSubmissionBundle({
      novel: {
        title: 'Duplicate Names',
        genre: 'fantasy',
        storySummary: '',
        characterSummary: '',
        arcSummary: '',
        stage: 'completed',
      },
      chapters: [
        { chapterNumber: 1, title: 'Same', content: 'first' },
        { chapterNumber: 1, title: 'Same', content: 'second' },
      ],
    });

    const entryNames = Object.keys(unzipSync(bundle));
    expect(entryNames).toContain('Chapters TXT/Chapter 0001 - Same.txt');
    expect(entryNames).toContain('Chapters TXT/Chapter 0001 - Same-2.txt');
    expect(entryNames).toContain('Chapters DOCX/Chapter 0001 - Same.docx');
    expect(entryNames).toContain('Chapters DOCX/Chapter 0001 - Same-2.docx');
  });
});

// C12: a CJKNotSupportedError from the PDF builder must skip PDF but keep the
// rest of the bundle; a DIFFERENT error must re-throw (not be swallowed by a
// brittle .name string match that a minified build could break).
describe('submission bundle PDF CJK-skip discrimination (C12)', () => {
  const input = {
    novel: { title: 'CJK Skip', genre: 'g', storySummary: '', characterSummary: '', arcSummary: '', stage: 'completed' },
    chapters: [{ chapterNumber: 1, title: 'One', content: 'ascii' }],
  };

  it('skips PDF and notes it when the PDF builder throws CJKNotSupportedError', async () => {
    vi.doMock('@/lib/exporters/pdf', () => ({
      CJKNotSupportedError,
      buildNovelPdfBuffer: vi.fn(async () => { throw new CJKNotSupportedError(); }),
    }));
    vi.resetModules();
    const { buildSubmissionBundle: buildFresh } = await import('@/lib/exporters/bundle');
    const bytes = await buildFresh(input as never);
    const { strFromU8 } = await import('fflate');
    const entries = unzipSync(bytes);
    const notes = strFromU8(entries['README.txt']);
    expect(notes).toMatch(/PDF was skipped/);
    expect(Object.keys(entries).some(n => n.endsWith('.pdf'))).toBe(false);
    expect(Object.keys(entries).some(n => n.endsWith('.epub'))).toBe(true);
    vi.doUnmock('@/lib/exporters/pdf');
    vi.resetModules();
  });

  it('re-throws a non-CJK PDF error instead of silently skipping', async () => {
    vi.doMock('@/lib/exporters/pdf', () => ({
      CJKNotSupportedError,
      buildNovelPdfBuffer: vi.fn(async () => { throw new Error('real PDF failure'); }),
    }));
    vi.resetModules();
    const { buildSubmissionBundle: buildFresh } = await import('@/lib/exporters/bundle');
    await expect(buildFresh(input as never)).rejects.toThrow('real PDF failure');
    vi.doUnmock('@/lib/exporters/pdf');
    vi.resetModules();
  });
});
