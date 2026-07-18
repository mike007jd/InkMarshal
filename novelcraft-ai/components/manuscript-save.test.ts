// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SAVE_NOW_EVENT,
  requestSaveNow,
  type SaveNowEventDetail,
} from '@/lib/desktop-shell-bus';
import {
  applyDraftContentToChapters,
  draftContentForActiveChapter,
  failedDraftSaveOutcome,
  type ManuscriptChapter,
} from '@/components/ManuscriptShell';

const chapters: ManuscriptChapter[] = [
  { id: 'ch-1', chapterNumber: 1, title: 'One', content: 'saved one' },
  { id: 'ch-2', chapterNumber: 2, title: 'Two', content: 'saved two' },
  { id: 'ch-3', chapterNumber: 3, title: 'Three', content: 'saved three' },
];

describe('manuscript save barriers', () => {
  it('intercepts native close until the active editor has saved successfully', () => {
    const shell = readFileSync(join(process.cwd(), 'components/DesktopShellLayout.tsx'), 'utf8');

    expect(shell).toContain('currentWindow.onCloseRequested(async event =>');
    expect(shell).toContain('event.preventDefault();');
    expect(shell).toContain('const saveOutcome = await requestSaveNow();');
    expect(shell).toContain('if (!saveOutcome.ok) {');
    expect(shell).toContain('await currentWindow.destroy();');
    expect(shell.indexOf('const saveOutcome = await requestSaveNow();'))
      .toBeLessThan(shell.indexOf('await currentWindow.destroy();'));
  });

  it('returns the first failed SaveNow listener outcome', async () => {
    const okListener = (event: Event) => {
      (event as CustomEvent<SaveNowEventDetail>).detail.waitUntil(Promise.resolve({ ok: true }));
    };
    const failedListener = (event: Event) => {
      (event as CustomEvent<SaveNowEventDetail>).detail.waitUntil(Promise.resolve({
        ok: false,
        chapterNumber: 2,
        title: 'Two',
      }));
    };
    window.addEventListener(SAVE_NOW_EVENT, okListener);
    window.addEventListener(SAVE_NOW_EVENT, failedListener);

    try {
      await expect(requestSaveNow()).resolves.toEqual({
        ok: false,
        chapterNumber: 2,
        title: 'Two',
      });
    } finally {
      window.removeEventListener(SAVE_NOW_EVENT, okListener);
      window.removeEventListener(SAVE_NOW_EVENT, failedListener);
    }
  });

  it('marks an explicit save request as a recovery-point save', async () => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<SaveNowEventDetail>).detail;
      expect(detail.createRecoveryPoint).toBe(true);
      detail.waitUntil(Promise.resolve({ ok: true, chapterNumber: 1 }));
    };
    window.addEventListener(SAVE_NOW_EVENT, listener);
    try {
      await expect(requestSaveNow({ createRecoveryPoint: true })).resolves.toEqual({ ok: true });
    } finally {
      window.removeEventListener(SAVE_NOW_EVENT, listener);
    }
  });

  it('blocks global save/export on the lowest-numbered orphaned dirty draft', () => {
    const drafts = new Map([
      [3, 'dirty three'],
      [2, 'dirty two'],
    ]);

    expect(failedDraftSaveOutcome(drafts, chapters)).toEqual({
      ok: false,
      chapterNumber: 2,
      title: 'Two',
    });
    expect(failedDraftSaveOutcome(new Map(), chapters)).toBeNull();
  });

  it('feeds failed-save draft text back into reading data and the active editor', () => {
    const drafts = new Map([[2, 'unsaved replacement']]);

    expect(applyDraftContentToChapters(chapters, drafts)).toEqual([
      chapters[0],
      { ...chapters[1], content: 'unsaved replacement' },
      chapters[2],
    ]);
    expect(draftContentForActiveChapter(chapters[1], drafts)).toBe('unsaved replacement');
    expect(draftContentForActiveChapter(chapters[0], drafts)).toBeUndefined();
    expect(draftContentForActiveChapter(null, drafts)).toBeUndefined();
  });
});
