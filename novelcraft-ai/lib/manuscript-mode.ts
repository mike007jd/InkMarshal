import type { LiveWritingChapter } from '@/lib/writing-session';

export type ManuscriptShellMode = 'writing-live' | 'reading-review';

export function resolveManuscriptShellMode(args: {
  didRequestAutostart: boolean;
  isStreaming: boolean;
  liveChapter: LiveWritingChapter | null;
  batchDone: unknown | null;
  resumePromptVisible: boolean;
}): ManuscriptShellMode {
  if (args.isStreaming || args.liveChapter) return 'writing-live';
  if (args.didRequestAutostart && !args.batchDone && !args.resumePromptVisible) {
    return 'writing-live';
  }
  return 'reading-review';
}
