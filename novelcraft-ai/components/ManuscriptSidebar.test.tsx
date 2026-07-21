import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ManuscriptSidebar } from '@/components/ManuscriptSidebar';
import { LocaleProvider } from '@/components/LanguageProvider';
import type { WritingRunState } from '@/lib/writing-session';

type Chapter = {
  id?: string;
  chapterNumber: number;
  title: string;
  content: string;
  wordCount: number;
};

const NOW = Date.parse('2026-07-21T12:00:00.000Z');

function activeRun(overrides: Partial<WritingRunState> = {}): WritingRunState {
  return {
    phase: 'drafting',
    statusLabel: 'Drafting chapter',
    modelLabel: 'Qwen3.5 9B',
    chapterNumber: 3,
    liveWordCount: 321,
    completedChapters: 2,
    totalChapters: 10,
    progress: 27,
    startedAt: new Date(NOW - 90_000).toISOString(),
    lastActivityAt: new Date(NOW - 2_000).toISOString(),
    ...overrides,
  };
}

function render(overrides: Partial<{
  title: string;
  genre: string;
  storySummary: string;
  chapters: Chapter[];
  writingRunState: WritingRunState | null;
  withRunControls: boolean;
}>) {
  return renderToStaticMarkup(
    <LocaleProvider>
      <ManuscriptSidebar
        title={overrides.title ?? 'My Novel'}
        genre={overrides.genre ?? 'Fantasy'}
        storySummary={overrides.storySummary ?? ''}
        progress={0}
        chapters={overrides.chapters ?? []}
        activeChapter={null}
        isWritingLive={false}
        viewMode="reading"
        onModeChange={() => {}}
        onChapterSelect={() => {}}
        writingRunState={overrides.writingRunState ?? null}
        writingRunControls={overrides.withRunControls
          ? { onPause: () => {}, onResume: () => {}, onRetry: () => {} }
          : undefined}
        runNowMs={NOW}
      />
    </LocaleProvider>,
  );
}

describe('ManuscriptSidebar export formats', () => {
  it('keeps all four formats behind one on-demand export menu', () => {
    const source = readFileSync(join(process.cwd(), 'components/ManuscriptSidebar.tsx'), 'utf8');

    expect(source).toContain("const exportFormats: Array<'txt' | 'docx' | 'pdf' | 'epub'> = ['epub', 'txt', 'docx', 'pdf'];");
    expect(source).toContain('<DropdownMenu>');
    expect(source).toContain('{t.exportNovel}');
    expect(source).not.toContain('className="flex gap-1.5"');
  });

  it('disables the single export trigger when there are no chapters', () => {
    const html = render({ chapters: [] });
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>[\s\S]*Export Novel/);
  });
});

describe('ManuscriptSidebar layout (regression: BUG-2 header overlap)', () => {
  it('clips the chapter list so its header cannot overlap the export header when squeezed', () => {
    // When the sidebar height is starved (e.g. the completed-novel unification
    // panel above), the flex-1 chapter-list container collapses to 0 height.
    // Without overflow-hidden its shrink-0 "Chapters" header overflowed and
    // rendered on top of the "Export Novel" header. The container must clip.
    const html = render({
      chapters: [{ chapterNumber: 1, title: 'Opening', content: 'text', wordCount: 5 }],
    });
    expect(html).toContain('min-h-0 flex-1 flex-col overflow-hidden');
  });
});

describe('ManuscriptSidebar writing-run panel', () => {
  it('replaces the plain Progress section with the compact run panel while a run is active', () => {
    const html = render({
      chapters: [{ chapterNumber: 3, title: 'Storm', content: 'text', wordCount: 5 }],
      writingRunState: activeRun(),
    });
    // Run narration is present…
    expect(html).toContain('Drafting chapter');
    expect(html).toContain('Qwen3.5 9B');
    expect(html).toContain('Ch.3');
    expect(html).toContain('321 words');
    expect(html).toContain('2/10');
    expect(html).toContain('Elapsed 1m 30s');
    // …and the ordinary "Progress" label is gone — no fourth card was added.
    expect(html).not.toContain('>Progress<');
  });

  it('keeps the plain Progress section when the run is idle or absent', () => {
    expect(render({ writingRunState: null })).toContain('>Progress<');
    expect(render({ writingRunState: activeRun({ phase: 'idle' }) })).toContain('>Progress<');
  });

  it('surfaces Resume / Retry / no-action across paused, failed and complete runs', () => {
    expect(render({
      writingRunState: activeRun({ phase: 'paused', statusLabel: 'Writing paused' }),
      withRunControls: true,
    })).toContain('Resume now');
    const failed = render({
      writingRunState: activeRun({ phase: 'failed', statusLabel: 'Writing failed', error: 'stream broke' }),
      withRunControls: true,
    });
    expect(failed).toContain('Retry');
    expect(failed).toContain('stream broke');
    const complete = render({
      writingRunState: activeRun({ phase: 'complete', statusLabel: 'All chapters written', progress: 100 }),
      withRunControls: true,
    });
    expect(complete).toContain('All chapters written');
    expect(complete).not.toContain('Resume now');
    expect(complete).not.toContain('>Retry<');
  });
});
