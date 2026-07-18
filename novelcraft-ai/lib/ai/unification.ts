import { type LanguageModel } from 'ai';
import { OUTPUT_TOKEN_CEILING } from '@/lib/ai/output-budget';
import { type Locale, isZhLocale } from '@/lib/i18n';
import {
  UNIFICATION_REPORT_LIMITS,
  UnificationReportSchema,
  type UnificationReportResult,
  type UsageMeta,
} from '@/lib/ai/types';
import type { NovelSettings } from '@/lib/db-types';
import { renderTemplate } from '@/lib/prompt-template';
import { resolveTemplate, variantForStage } from '@/lib/ai/prompt-runner';
import { generateStructuredObject } from '@/lib/ai/structured-output';

const DEFAULT_UNIFICATION_BATCH_CHAR_BUDGET = 120_000;

export interface UnificationChapterInput {
  chapterNumber: number;
  title: string;
  content: string;
}

export interface UnificationStats {
  majorCount: number;
  minorCount: number;
  affectedChapters: number[];
  batchCount: number;
}

export interface GenerateUnificationArgs {
  model: LanguageModel;
  novelContext: { title?: string; genre?: string; settings?: NovelSettings | null };
  chapters: UnificationChapterInput[];
  knowledgeContext?: string;
  language?: Locale;
  signal?: AbortSignal;
  systemPrompt?: string;
  maxBatchChars?: number;
  /** W3-2: per-novel prompt variant (falls back to novelContext.settings, then 'default'). */
  promptVariant?: string;
}

export function buildUnificationBatches(
  chapters: UnificationChapterInput[],
  maxBatchChars: number = DEFAULT_UNIFICATION_BATCH_CHAR_BUDGET,
): UnificationChapterInput[][] {
  const batches: UnificationChapterInput[][] = [];
  let current: UnificationChapterInput[] = [];
  let currentChars = 0;
  const budget = Math.max(maxBatchChars, 1);

  for (const chapter of chapters) {
    const chapterChars = chapter.title.length + chapter.content.length + 32;
    if (current.length > 0 && currentChars + chapterChars > budget) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(chapter);
    currentChars += chapterChars;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}


const UNIFICATION_FALLBACK = `You are unifying a complete novel "{{novelTitle}}" ({{genre}}). Identify and propose verbatim find/replace edits for cross-chapter inconsistencies only — character name spelling drift, contradictory facts, broken timeline, POV slips. Do NOT rewrite for style.

{{knowledgeSection}}

Manuscript:
---
{{chapterDump}}
---

{{langNote}}

For each issue: pick the chapter where the wrong text lives, set "original" to a verbatim substring (so it can be located by exact match), give the corrected "replacement", a short "rationale" (why this fixes a cross-chapter inconsistency), and severity 'major' (breaks reader trust) or 'minor' (small drift). Surface the most impactful first.`;

function buildUnificationPrompt(args: {
  novelContext: { title?: string; genre?: string };
  chapters: UnificationChapterInput[];
  knowledgeContext?: string;
  language?: Locale;
  variant?: string;
}): string {
  const { novelContext, chapters, knowledgeContext, language = 'en', variant } = args;
  const langNote = isZhLocale(language)
    ? '修订建议的 rationale/summary 用中文。'
    : 'Write rationale and summary in English.';

  const chapterDump = chapters
    .map(ch => `=== Chapter ${ch.chapterNumber}: ${ch.title} ===\n${ch.content}`)
    .join('\n\n');

  const template = resolveTemplate('unification', 'user', language, UNIFICATION_FALLBACK, variant);
  return renderTemplate(template, {
    novelTitle: novelContext.title ?? '',
    genre: novelContext.genre ?? '',
    knowledgeSection: knowledgeContext ? `Canonical reference:\n${knowledgeContext}\n` : '',
    chapterDump,
    langNote,
  });
}

// Truncate to a max length without slicing through a UTF-16 surrogate pair
// (which would corrupt an astral-plane char — rare in prose, possible in
// names/emoji). Drops a trailing lone high surrogate left by the cut.
function truncatePreservingCodepoints(str: string, max: number): string {
  if (str.length <= max) return str;
  let end = max;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return str.slice(0, end);
}

function aggregateStats(report: UnificationReportResult, batchCount: number): UnificationStats {
  let majorCount = 0;
  let minorCount = 0;
  const affected = new Set<number>();
  for (const edit of report.edits) {
    if (edit.severity === 'major') majorCount++;
    else minorCount++;
    affected.add(edit.chapterNumber);
  }
  return {
    majorCount,
    minorCount,
    affectedChapters: Array.from(affected).sort((a, b) => a - b),
    batchCount,
  };
}

export async function generateUnificationReport(args: GenerateUnificationArgs): Promise<{
  result: UnificationReportResult;
  stats: UnificationStats;
  usage?: UsageMeta;
}> {
  const { model, signal, systemPrompt, language, novelContext, chapters, knowledgeContext, maxBatchChars, promptVariant } = args;
  const variant = promptVariant ?? variantForStage(novelContext.settings, 'unification');
  const batches = buildUnificationBatches(chapters, maxBatchChars);

  if (batches.length <= 1) {
    const prompt = buildUnificationPrompt({ novelContext, chapters, knowledgeContext, language, variant });
    const result = await generateStructuredObject({
      model,
      schema: UnificationReportSchema,
      operation: 'unify',
      system: systemPrompt,
      prompt,
      maxOutputTokens: OUTPUT_TOKEN_CEILING,
      abortSignal: signal,
    });
    return {
      result: result.object,
      stats: aggregateStats(result.object, 1),
      usage: result.usage,
    };
  }

  const mergedEdits: UnificationReportResult['edits'] = [];
  const summaries: string[] = [];
  let aggregatedUsage: UsageMeta | undefined;

  for (let i = 0; i < batches.length; i++) {
    if (mergedEdits.length >= UNIFICATION_REPORT_LIMITS.edits) break;
    const batchChapters = batches[i];
    const prompt = buildUnificationPrompt({
      novelContext,
      chapters: batchChapters,
      knowledgeContext,
      language,
      variant,
    });
    const result = await generateStructuredObject({
      model,
      schema: UnificationReportSchema,
      operation: 'unify',
      system: systemPrompt,
      prompt,
      maxOutputTokens: OUTPUT_TOKEN_CEILING,
      abortSignal: signal,
    });
    // The loop-top guard guarantees mergedEdits.length < the cap here, so
    // remainingEdits is always positive.
    const remainingEdits = UNIFICATION_REPORT_LIMITS.edits - mergedEdits.length;
    mergedEdits.push(...result.object.edits.slice(0, remainingEdits));
    if (result.object.summary.trim()) {
      summaries.push(`Batch ${i + 1}/${batches.length}: ${result.object.summary.trim()}`);
    }
    if (result.usage) {
      aggregatedUsage = aggregatedUsage
        ? {
            inputTokens: (aggregatedUsage.inputTokens ?? 0) + (result.usage.inputTokens ?? 0),
            outputTokens: (aggregatedUsage.outputTokens ?? 0) + (result.usage.outputTokens ?? 0),
            totalTokens: (aggregatedUsage.totalTokens ?? 0) + (result.usage.totalTokens ?? 0),
          }
        : { ...result.usage };
    }
  }

  // Sort: major first, then by chapter number. Stable so repeat batches keep
  // their relative order.
  mergedEdits.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'major' ? -1 : 1;
    return a.chapterNumber - b.chapterNumber;
  });

  const merged: UnificationReportResult = {
    edits: mergedEdits,
    summary: truncatePreservingCodepoints(summaries.join('\n'), UNIFICATION_REPORT_LIMITS.summary),
  };

  return {
    result: merged,
    stats: aggregateStats(merged, batches.length),
    usage: aggregatedUsage,
  };
}
