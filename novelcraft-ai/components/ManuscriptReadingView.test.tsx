import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { ManuscriptReadingView } from '@/components/ManuscriptReadingView';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';
import { LocaleProvider } from '@/components/LanguageProvider';

const chapter: ManuscriptChapter = {
  id: 'ch-1',
  chapterNumber: 1,
  title: 'The First Page',
  content: 'He measured every unspoken debt against the long habit of forgetting.',
};

function renderContinuous() {
  return renderToStaticMarkup(
    <LocaleProvider>
      <ManuscriptReadingView
        novelId="nv-test"
        chapters={[chapter]}
        liveChapter={null}
        mode="reading-review"
        activeChapter={1}
        layout="continuous"
        onLayoutChange={() => {}}
      />
    </LocaleProvider>,
  );
}

describe('ManuscriptReadingView chapter eyebrow label (regression: BUG-1)', () => {
  it('interpolates the {num} placeholder instead of leaving it literal', () => {
    const markup = renderContinuous();
    // The bug rendered the raw template "Chapter {num} 01"; the eyebrow must be "Chapter 01".
    expect(markup).not.toContain('{num}');
    expect(markup).not.toContain('{NUM}');
    expect(markup).toContain('Chapter 01');
  });

  it('zero-pads the chapter number', () => {
    const markup = renderContinuous();
    expect(markup).toContain('Chapter 01');
    expect(markup).not.toContain('Chapter 1 01');
  });
});
