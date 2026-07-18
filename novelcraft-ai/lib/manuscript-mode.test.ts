import { describe, expect, it } from 'vitest';

import { resolveManuscriptShellMode } from '@/lib/manuscript-mode';
import type { LiveWritingChapter } from '@/lib/writing-session';

const liveChapter: LiveWritingChapter = {
  id: 'live-2',
  chapterNumber: 2,
  title: 'Chapter 2',
  content: 'partial',
};

describe('resolveManuscriptShellMode', () => {
  it('keeps editing disabled only while this client is actively writing or showing live prose', () => {
    expect(resolveManuscriptShellMode({
      didRequestAutostart: false,
      isStreaming: true,
      liveChapter: null,
      batchDone: null,
      resumePromptVisible: false,
    })).toBe('writing-live');

    expect(resolveManuscriptShellMode({
      didRequestAutostart: false,
      isStreaming: false,
      liveChapter,
      batchDone: null,
      resumePromptVisible: false,
    })).toBe('writing-live');
  });

  it('returns to reading-review for clean pause points and manual resume prompts', () => {
    expect(resolveManuscriptShellMode({
      didRequestAutostart: false,
      isStreaming: false,
      liveChapter: null,
      batchDone: { completedChapter: 1, remaining: 2 },
      resumePromptVisible: false,
    })).toBe('reading-review');

    expect(resolveManuscriptShellMode({
      didRequestAutostart: false,
      isStreaming: false,
      liveChapter: null,
      batchDone: null,
      resumePromptVisible: true,
    })).toBe('reading-review');
  });

  it('keeps the shell locked during an unresolved autostart handoff', () => {
    expect(resolveManuscriptShellMode({
      didRequestAutostart: true,
      isStreaming: false,
      liveChapter: null,
      batchDone: null,
      resumePromptVisible: false,
    })).toBe('writing-live');
  });
});
