import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ManuscriptSidebar } from '@/components/ManuscriptSidebar';
import { LocaleProvider } from '@/components/LanguageProvider';

type Chapter = {
  id?: string;
  chapterNumber: number;
  title: string;
  content: string;
  wordCount: number;
};

function render(overrides: Partial<{
  title: string;
  genre: string;
  storySummary: string;
  chapters: Chapter[];
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
