import type { GenerationPreset } from '@/lib/ai/generation-presets';
import type { AIStreamLifecycle } from '@/lib/ai-usage';
import type { Chapter, Novel } from '@/lib/db';
import type { Locale } from '@/lib/i18n';
import type { WritingLease } from '@/lib/writing/lease';

type StartWritingLogger = (
  event: string,
  fields?: Record<string, string | number | boolean | undefined>,
) => void;

export interface WritingJobPort {
  bumpProgress(currentChapter: number, seq: number): void;
  finalize(
    status: 'completed' | 'paused' | 'failed',
    endReason: string,
    errorMessage: string | null | undefined,
    novelUpdate: Partial<Novel>,
    assistantMessage?: string,
  ): Novel;
}

export interface StartWritingContext {
  novelId: string;
  userId: string;
  novel: Novel;
  request: Request;
  systemPrompt: string;
  knowledgeSummaries: string;
  language: Locale;
  chapterPreset: GenerationPreset;
  existingChapters: Chapter[];
  messageCount: number;
  chaptersLimit: number;
  untilChapter: number | null;
  requestStartedAt: number;
  lifecycle: AIStreamLifecycle;
  lease: WritingLease;
  jobs: WritingJobPort;
  log: StartWritingLogger;
}
