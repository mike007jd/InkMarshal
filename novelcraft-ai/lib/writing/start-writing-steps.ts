// Per-chapter + blueprint steps for the autonomous writing flow, extracted
// verbatim from the start-writing route (Phase 3) so the route stays a thin
// adapter and these are independently testable. Each step owns its own
// AIUsageSession lifecycle (record on success, fail on error). Server-only:
// loads the DB + AI layers.
//
// NOTE: logic is copied unchanged from the old route — the writeChapter hard
// invariants (row-before-usage, length-continuation, Ralph 0.8 retention,
// lock_failed) live in lib/writing-orchestrator and are NOT touched here.

import {
  appendVolumeSummary,
  getNovelBlueprint,
  getVolumeSummaries,
  setNovelBlueprint,
  type ChapterKeyFacts,
  type ChapterQualityIssue,
  type NovelBlueprint,
} from '@/lib/db';
import {
  generateBookBlueprint,
  getTargetWordsPerChapter,
  reviseChapterForRalphLoop,
  summarizeChapter,
  summarizeVolume,
  validateChapter,
  type ChapterBlueprint,
  type RollingDigestSource,
} from '@/lib/ai';
import { type Locale } from '@/lib/i18n';
import { START_WRITING_EVENTS } from '@/lib/start-writing-logging';
import { countWords } from '@/lib/utils';
import { createAIUsageSession, type AIUsageSession } from '@/lib/ai-usage';

// Trigger a volume summary once we accumulate enough chapters + words past the
// last summary boundary. The thresholds keep early novels (<=100k words) on
// per-chapter digest only; longer novels start getting volumes to keep the
// rolling memory window bounded.
const VOLUME_SUMMARY_MIN_CHAPTERS = 10;
const VOLUME_SUMMARY_MIN_WORDS_TOTAL = 100_000;

interface PostChapterArgsBase {
  request: Request;
  userId: string;
  signal?: AbortSignal;
  chapterContent: string;
  language: Locale;
  systemPrompt: string;
  chapterNumber: number;
  log: (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;
}

interface RunSummarizeArgs extends PostChapterArgsBase {
  chapterTitle: string;
  plan: ChapterBlueprint;
}

export async function runSummarize(args: RunSummarizeArgs): Promise<{
  summary: string;
  keyFacts: ChapterKeyFacts | null;
  recordUsage: () => Promise<void>;
  failUsage: () => Promise<void>;
  cancelUsage: () => Promise<void>;
}> {
  const usage = await createAIUsageSession(args.request, { userId: args.userId, operation: 'summarize' });
  let usageSettled = false;
  const failUsageOnce = async () => {
    if (!usageSettled) {
      usageSettled = true;
      await usage.fail();
    }
  };
  const cancelUsageOnce = async () => {
    if (!usageSettled) {
      usageSettled = true;
      await usage.cancel();
    }
  };
  try {
    usage.addPromptText(args.chapterContent.slice(0, 4000));
    const result = await summarizeChapter({
      model: usage.model,
      chapterContent: args.chapterContent,
      chapterTitle: args.chapterTitle,
      blueprint: args.plan,
      language: args.language,
      systemPrompt: args.systemPrompt,
      signal: args.signal,
    });
    usage.addPartialOutput(result.result.summary);
    if (args.signal?.aborted) {
      throw new Error('summarize cancelled');
    }
    const recordUsage = async () => {
      try {
        await usage.recordUsage(result.usage);
        usageSettled = true;
        args.log(START_WRITING_EVENTS.summarizeDone, {
          ch: args.chapterNumber,
          chars: result.result.summary.length,
        });
      } catch (error) {
        await failUsageOnce();
        throw error;
      }
    };
    return {
      summary: result.result.summary,
      keyFacts: result.result.keyFacts,
      recordUsage,
      failUsage: failUsageOnce,
      cancelUsage: cancelUsageOnce,
    };
  } catch (err) {
    if (args.signal?.aborted) await cancelUsageOnce();
    else await failUsageOnce();
    args.log(START_WRITING_EVENTS.summarizeDone, {
      ch: args.chapterNumber,
      fallback: 'tail',
      error: err instanceof Error ? err.message : 'unknown',
    });
    throw err;
  }
}

interface RunValidateArgs extends PostChapterArgsBase {
  chapterTitle: string;
  knowledgeContext: string;
  previousFactsSummary: string;
  targetWords: number;
}

export async function runValidate(args: RunValidateArgs): Promise<{
  issues: ChapterQualityIssue[] | null;
  score: number | null;
  recordUsage: () => Promise<void>;
  failUsage: () => Promise<void>;
  cancelUsage: () => Promise<void>;
}> {
  const usage = await createAIUsageSession(args.request, { userId: args.userId, operation: 'validate' });
  let usageSettled = false;
  const failUsageOnce = async () => {
    if (!usageSettled) {
      usageSettled = true;
      await usage.fail();
    }
  };
  const cancelUsageOnce = async () => {
    if (!usageSettled) {
      usageSettled = true;
      await usage.cancel();
    }
  };
  try {
    usage.addPromptText(args.chapterContent.slice(0, 4000));
    const result = await validateChapter({
      model: usage.model,
      chapterContent: args.chapterContent,
      chapterTitle: args.chapterTitle,
      knowledgeContext: args.knowledgeContext,
      previousFactsSummary: args.previousFactsSummary,
      targetWords: args.targetWords,
      language: args.language,
      systemPrompt: args.systemPrompt,
      signal: args.signal,
    });
    usage.addPartialOutput(JSON.stringify(result.result));
    if (args.signal?.aborted) {
      throw new Error('validate cancelled');
    }
    const recordUsage = async () => {
      try {
        await usage.recordUsage(result.usage);
        usageSettled = true;
        args.log(START_WRITING_EVENTS.validateDone, {
          ch: args.chapterNumber,
          issues: result.result.consistencyIssues.length,
          score: result.result.overallScore,
        });
      } catch (error) {
        await failUsageOnce();
        throw error;
      }
    };
    return {
      issues: result.result.consistencyIssues.length > 0 ? result.result.consistencyIssues : null,
      score: result.result.overallScore,
      recordUsage,
      failUsage: failUsageOnce,
      cancelUsage: cancelUsageOnce,
    };
  } catch (err) {
    if (args.signal?.aborted) await cancelUsageOnce();
    else await failUsageOnce();
    args.log(START_WRITING_EVENTS.validateDone, {
      ch: args.chapterNumber,
      fallback: 'skipped',
      error: err instanceof Error ? err.message : 'unknown',
    });
    throw err;
  }
}

interface RunRalphRevisionArgs extends PostChapterArgsBase {
  chapterTitle: string;
  plan: ChapterBlueprint;
  novel: { title?: string; genre?: string };
  revisionBrief: string;
}

export async function runRalphRevision(args: RunRalphRevisionArgs): Promise<{
  content: string;
  recordUsage: () => Promise<void>;
  failUsage: () => Promise<void>;
  cancelUsage: () => Promise<void>;
}> {
  const usage = await createAIUsageSession(args.request, { userId: args.userId, operation: 'polish' });
  let usageSettled = false;
  const failUsageOnce = async () => {
    if (!usageSettled) {
      usageSettled = true;
      await usage.fail();
    }
  };
  const cancelUsageOnce = async () => {
    if (!usageSettled) {
      usageSettled = true;
      await usage.cancel();
    }
  };
  try {
    usage.addPromptText(args.revisionBrief);
    usage.addPromptText(args.chapterContent.slice(0, 6000));
    const result = await reviseChapterForRalphLoop({
      model: usage.model,
      novelContext: args.novel,
      chapterContent: args.chapterContent,
      chapterTitle: args.chapterTitle,
      blueprint: args.plan,
      revisionBrief: args.revisionBrief,
      language: args.language,
      systemPrompt: args.systemPrompt,
      signal: args.signal,
    });
    usage.addPartialOutput(result.text.slice(0, 4000));
    if (args.signal?.aborted) {
      throw new Error('ralph revision cancelled');
    }
    const recordUsage = async () => {
      try {
        await usage.recordUsage(result.usage);
        usageSettled = true;
        args.log(START_WRITING_EVENTS.validateDone, {
          ch: args.chapterNumber,
          ralphRevision: true,
        });
      } catch (error) {
        await failUsageOnce();
        throw error;
      }
    };
    return {
      content: result.text || args.chapterContent,
      recordUsage,
      failUsage: failUsageOnce,
      cancelUsage: cancelUsageOnce,
    };
  } catch (err) {
    if (args.signal?.aborted) await cancelUsageOnce();
    else await failUsageOnce();
    args.log(START_WRITING_EVENTS.validateDone, {
      ch: args.chapterNumber,
      ralphRevision: 'failed',
      error: err instanceof Error ? err.message : 'unknown',
    });
    throw err;
  }
}

interface LoadBlueprintArgs {
  novelId: string;
  userId: string;
  novel: { title?: string; genre?: string; storySummary?: string; characterSummary?: string; arcSummary?: string; targetWords?: number };
  systemPrompt: string;
  language: Locale;
  request: Request;
  signal?: AbortSignal;
  existingChapters: Array<{ chapterNumber: number }>;
  log: (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;
}

export async function loadOrGenerateBlueprint(args: LoadBlueprintArgs): Promise<NovelBlueprint> {
  const existing = await getNovelBlueprint(args.novelId);

  // Reuse only when blueprint is internally valid and either nothing has been
  // written yet or every existing chapter number is covered. Coverage mismatch
  // implies the user added/removed chapters manually — safer to regenerate.
  if (existing && existing.chapters && existing.chapters.length > 0) {
    const planNumbers = new Set(existing.chapters.map(c => c.chapterNumber));
    const allCovered = args.existingChapters.every(c => planNumbers.has(c.chapterNumber));
    if (allCovered) {
      args.log(START_WRITING_EVENTS.blueprintReused, {
        chapters: existing.chapters.length,
        existingChapters: args.existingChapters.length,
      });
      return existing;
    }
    args.log(START_WRITING_EVENTS.blueprintReused, { skipped: 'coverage_mismatch' });
  }

  args.log(START_WRITING_EVENTS.blueprintStart);
  const blueprintUsage = await createAIUsageSession(args.request, {
    userId: args.userId,
    operation: 'outline',
  });
  let usageSettled = false;
  const failBlueprintUsageOnce = async () => {
    if (!usageSettled) {
      usageSettled = true;
      await blueprintUsage.fail();
    }
  };
  const cancelBlueprintUsageOnce = async () => {
    if (!usageSettled) {
      usageSettled = true;
      await blueprintUsage.cancel();
    }
  };
  try {
    blueprintUsage.addPromptText(args.systemPrompt);
    blueprintUsage.addPromptText(JSON.stringify({
      title: args.novel.title,
      genre: args.novel.genre,
      targetWords: args.novel.targetWords,
    }));
    const blueprintResult = await generateBookBlueprint({
      model: blueprintUsage.model,
      novelContext: args.novel,
      language: args.language,
      systemPrompt: args.systemPrompt,
      signal: args.signal,
    });
    const chapters = blueprintResult.chapters;
    blueprintUsage.addPartialOutput(JSON.stringify(chapters));
    if (args.signal?.aborted) {
      throw new Error('blueprint cancelled');
    }

    const targetWordsPerChapter = getTargetWordsPerChapter(
      Number(args.novel.targetWords) || 80_000,
      chapters.length,
    );

    const blueprint: NovelBlueprint = {
      chapters,
      targetWordsPerChapter,
      generatedAt: new Date().toISOString(),
      modelId: blueprintUsage.runtimeModel.id,
    };
    await setNovelBlueprint(args.novelId, blueprint);
    await blueprintUsage.recordUsage(blueprintResult.usage);
    usageSettled = true;
    args.log(START_WRITING_EVENTS.blueprintPersisted, {
      chapters: chapters.length,
      targetWordsPerChapter,
    });
    args.log(START_WRITING_EVENTS.blueprintDone, { chapters: chapters.length });
    return blueprint;
  } catch (err) {
    if (args.signal?.aborted) await cancelBlueprintUsageOnce();
    else await failBlueprintUsageOnce();
    throw err;
  }
}

interface VolumeSummaryArgs {
  request: Request;
  userId: string;
  novelId: string;
  digestSources: RollingDigestSource[];
  systemPrompt: string;
  language: Locale;
  signal?: AbortSignal;
  log: (event: string, fields?: Record<string, string | number | boolean | undefined>) => void;
}

export async function maybeRunVolumeSummary(args: VolumeSummaryArgs): Promise<void> {
  if (args.signal?.aborted) return;
  const sorted = [...args.digestSources].sort((a, b) => a.chapterNumber - b.chapterNumber);
  if (sorted.length === 0) return;
  // Read from DB rather than a module-level Map — the Map would survive across
  // requests in a long-lived Node process and slowly leak novel ids.
  // appendVolumeSummary dedups by (start,end), so a re-read is cheap and
  // idempotent.
  const summaries = await getVolumeSummaries(args.novelId);
  const lastBoundary = summaries.reduce((max, s) => Math.max(max, s.end), 0);
  const tail = sorted.filter(s => s.chapterNumber > lastBoundary);
  if (tail.length < VOLUME_SUMMARY_MIN_CHAPTERS) return;
  const tailWords = tail.reduce((sum, ch) => sum + countWords(ch.content || ''), 0);
  if (tailWords < VOLUME_SUMMARY_MIN_WORDS_TOTAL) return;

  // Have something to summarise. Use the 'summarize' op (recall role) so it
  // routes to the lightweight recall model the user bound, not a draft-class model.
  let usage: AIUsageSession;
  try {
    usage = await createAIUsageSession(args.request, {
      userId: args.userId,
      operation: 'summarize',
    });
  } catch (err) {
    args.log(START_WRITING_EVENTS.summarizeDone, {
      ch: tail[tail.length - 1].chapterNumber,
      fallback: 'volume_summary_no_model',
      error: err instanceof Error ? err.message : 'unknown',
    });
    return;
  }

  let usageSettled = false;
  const failUsageOnce = async () => {
    if (!usageSettled) {
      usageSettled = true;
      await usage.fail();
    }
  };
  const cancelUsageOnce = async () => {
    if (!usageSettled) {
      usageSettled = true;
      await usage.cancel();
    }
  };

  try {
    usage.addPromptText(args.systemPrompt);
    const result = await summarizeVolume({
      model: usage.model,
      chapters: tail.map(ch => ({
        chapterNumber: ch.chapterNumber,
        title: ch.title,
        summary: ch.summary || '',
      })),
      language: args.language,
      systemPrompt: args.systemPrompt,
      signal: args.signal,
    });
    usage.addPartialOutput(result.result.summary);
    if (args.signal?.aborted) {
      await cancelUsageOnce();
      return;
    }
    await appendVolumeSummary(args.novelId, result.result);
    await usage.recordUsage(result.usage);
    usageSettled = true;
    args.log(START_WRITING_EVENTS.summarizeDone, {
      ch: result.result.end,
      volumeStart: result.result.start,
      volumeEnd: result.result.end,
      volumeChars: result.result.summary.length,
    });
  } catch (err) {
    if (args.signal?.aborted) await cancelUsageOnce();
    else await failUsageOnce();
    args.log(START_WRITING_EVENTS.summarizeDone, {
      ch: tail[tail.length - 1].chapterNumber,
      fallback: 'volume_summary_failed',
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}
