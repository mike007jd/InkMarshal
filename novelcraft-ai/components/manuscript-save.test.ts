// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MANUSCRIPT_FLUSH_EVENT,
  requestManuscriptFlush,
  type ManuscriptFlushEventDetail,
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
  it('does not turn ordinary window close into a manuscript save workflow', () => {
    const shell = readFileSync(join(process.cwd(), 'components/DesktopShellLayout.tsx'), 'utf8');

    expect(shell).not.toContain('onCloseRequested');
    expect(shell).not.toContain('currentWindow.destroy');
  });

  it('tears down the bundled runtime only after the window is destroyed', () => {
    const rust = readFileSync(join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');

    expect(rust).toContain('.on_window_event(|window, event|');
    expect(rust).toContain('WindowEvent::Destroyed');
    expect(rust).not.toContain('WindowEvent::CloseRequested');
  });

  it('returns the first failed manuscript flush outcome', async () => {
    const okListener = (event: Event) => {
      (event as CustomEvent<ManuscriptFlushEventDetail>).detail.waitUntil(Promise.resolve({ ok: true }));
    };
    const failedListener = (event: Event) => {
      (event as CustomEvent<ManuscriptFlushEventDetail>).detail.waitUntil(Promise.resolve({
        ok: false,
        chapterNumber: 2,
        title: 'Two',
      }));
    };
    window.addEventListener(MANUSCRIPT_FLUSH_EVENT, okListener);
    window.addEventListener(MANUSCRIPT_FLUSH_EVENT, failedListener);

    try {
      await expect(requestManuscriptFlush()).resolves.toEqual({
        ok: false,
        chapterNumber: 2,
        title: 'Two',
      });
    } finally {
      window.removeEventListener(MANUSCRIPT_FLUSH_EVENT, okListener);
      window.removeEventListener(MANUSCRIPT_FLUSH_EVENT, failedListener);
    }
  });

  it('marks an explicit save request as a snapshot save', async () => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<ManuscriptFlushEventDetail>).detail;
      expect(detail.createSnapshot).toBe(true);
      detail.waitUntil(Promise.resolve({ ok: true, chapterNumber: 1 }));
    };
    window.addEventListener(MANUSCRIPT_FLUSH_EVENT, listener);
    try {
      await expect(requestManuscriptFlush({ createSnapshot: true })).resolves.toEqual({ ok: true });
    } finally {
      window.removeEventListener(MANUSCRIPT_FLUSH_EVENT, listener);
    }
  });

  it('blocks manuscript flush/export on the lowest-numbered orphaned dirty draft', () => {
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
