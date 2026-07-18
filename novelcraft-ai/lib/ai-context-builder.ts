// Unified AI context assembler for all generation / chat / rewrite / edit /
// unify routes.
//
// One entry point — `buildAIContext` — replaces the previous ad-hoc mix of
// `buildNovelSystemPromptFromDB` (system + knowledge only, no memory) and the
// inline `buildRollingDigest` in start-writing (memory only, single op kind).
// Every AI route now gets the same shape:
//
//   { novel, systemPrompt, knowledgeBlock, memoryBlock, conversationDigest, budget }
//
// with `op`-specific sizing so a "fix typo" edit doesn't drag the whole
// 80-chapter rolling digest into the prompt, and a chat about character A
// still sees recent chapter tails for continuity.
//
// Storage compatibility note (wave 2 commit C):
//   The recall path tries the new FS-backed `recallKnowledgeForChapter` first.
//   When the vault index is empty (user hasn't migrated yet) or recall throws
//   for any reason, we fall back to the legacy `buildSummaryInjection` against
//   `knowledge_entries` so the chapter still drafts. The public
//   shape returned here is unchanged.

import type { Locale } from '@/lib/i18n';
import { isZhLocale, normalizeLocale } from '@/lib/i18n';
import {
  getChapters,
  getKnowledgeEntries,
  getNovel,
  getVolumeSummaries,
  type Chapter,
  type Novel,
} from '@/lib/db';
import {
  adaptiveDigestParams,
  buildRollingDigest,
  type RollingDigestSource,
} from '@/lib/ai';
import type { VolumeSummary } from '@/lib/ai/types';
import {
  buildKnowledgeEntrySummary,
  buildSummaryInjection,
  parseKnowledgeEntry,
} from '@/lib/knowledge';
import { recallKnowledgeForChapter } from '@/lib/knowledge/recall';
import type { EmbeddingEndpointHint } from '@/lib/knowledge/embedding';
import type {
  KnowledgeEntry,
  StyleReferenceData,
  StyleReferenceEntry,
} from '@/lib/types/knowledge';
import { assembleSystemPrompt } from '@/lib/ai-context';
import { summarizeConversationsForContext } from '@/lib/conversations';
import {
  classifyPressure,
  estimateTokens,
  FALLBACK_CTX_TOKENS,
  type ContextPressure,
} from '@/lib/token-budget';
import { normalizeStyleId } from '@/lib/style-id';

/**
 * Coarse classification of an AI operation. The builder consults the budget
 * table below to decide knowledge size, memory window, volume-summary count,
 * and conversation-digest size.
 *
 * Mapping to existing `AIUsageOperation`/`OperationKind` is intentionally not
 * 1:1: a single OperationKind ('polish') maps onto both 'rewrite' (large
 * selection) and 'edit' (surgical change). The route decides which to pass.
 */
export type AIOpKind =
  | 'chapter'
  | 'continue'
  | 'rewrite'
  | 'edit'
  | 'chat'
  | 'unify'
  | 'outline';

/** Per-op budget. Numbers in characters except `recentWindow` (chapter count). */
interface OpBudget {
  knowledgeChars: number;
  /** Chapters of recent tail to include verbatim; `'adaptive'` defers to chapter-quality. */
  recentWindow: number | 'adaptive';
  /** Per-chapter tail length; `'adaptive'` defers to chapter-quality. */
  tailCharsPerChapter: number | 'adaptive';
  /** How many volume summaries to include. `'all'` = the lot; `'lastN'` = trailing N. */
  volumeSummaries: 'all' | 'none' | { lastN: number };
  /** Char budget for conversation digest; 0 = none. */
  conversationDigestChars: number;
  /** Topics to bias the conversation digest toward. Empty = no filter. */
  conversationTopics: string[];
}

/**
 * Per-op budget table (plan §1.4). Knowledge sizes match the plan; memory
 * sizes converted from "chapters × tailChars" to the buildRollingDigest
 * recentWindow/tailCharsPerChapter signature.
 *
 * `edit` deliberately runs with recentWindow=0: surgical edits should never
 * drag in unrelated prior chapter tails — only knowledge + (when needed) the
 * current chapter content the route passes via `focus.selectedText`.
 */
const OP_BUDGETS: Record<AIOpKind, OpBudget> = {
  chapter: {
    knowledgeChars: 12_000,
    recentWindow: 'adaptive',
    tailCharsPerChapter: 'adaptive',
    volumeSummaries: 'all',
    conversationDigestChars: 2_000,
    conversationTopics: ['plot', 'characters', 'worldbuilding'],
  },
  continue: {
    knowledgeChars: 8_000,
    recentWindow: 2,
    tailCharsPerChapter: 2_000,
    volumeSummaries: { lastN: 2 },
    conversationDigestChars: 1_000,
    conversationTopics: ['chapter_editing', 'plot'],
  },
  rewrite: {
    knowledgeChars: 6_000,
    recentWindow: 1,
    tailCharsPerChapter: 1_500,
    volumeSummaries: { lastN: 1 },
    conversationDigestChars: 500,
    conversationTopics: ['chapter_editing'],
  },
  edit: {
    knowledgeChars: 4_000,
    recentWindow: 0,
    tailCharsPerChapter: 1_500,
    volumeSummaries: 'none',
    conversationDigestChars: 0,
    conversationTopics: [],
  },
  chat: {
    knowledgeChars: 6_000,
    // "卷概览" = volume summaries only; per-chapter tail unnecessary in chat.
    recentWindow: 0,
    tailCharsPerChapter: 1_500,
    volumeSummaries: 'all',
    conversationDigestChars: 1_500,
    conversationTopics: [],
  },
  unify: {
    knowledgeChars: 12_000,
    // Unification reads chapters directly via its own batching; the builder
    // doesn't need to inject per-chapter tails. Volume summaries are useful
    // for cross-chapter context.
    recentWindow: 0,
    tailCharsPerChapter: 1_500,
    volumeSummaries: 'all',
    conversationDigestChars: 0,
    conversationTopics: [],
  },
  outline: {
    knowledgeChars: 8_000,
    recentWindow: 0,
    tailCharsPerChapter: 1_500,
    volumeSummaries: 'all',
    conversationDigestChars: 1_000,
    conversationTopics: ['plot', 'characters', 'worldbuilding'],
  },
};

export interface BuildAIContextFocus {
  chapterNumber?: number;
  /** Trailing text from the editor selection (used by `continue`). */
  selectionTail?: string;
  /** Selected text being rewritten (used by `rewrite`/`edit`). */
  selectedText?: string;
  /** Active conversation id (used by `chat`). */
  conversationId?: string;
  /** Extra entities to bias knowledge recall toward (commit B will use). */
  extraEntities?: string[];
}

export interface BuildAIContextArgs {
  novelId: string;
  locale: string;
  /** Pre-fetched novel to avoid a redundant round-trip. */
  novel?: Novel;
  op: AIOpKind;
  focus?: BuildAIContextFocus;
  /** Engine-reported ctx window (tokens); takes precedence over catalog. */
  modelCtxTokens?: number;
  /**
   * Omit the rolling memory (recent chapter tails + earlier digest + volume
   * summaries) from the assembled `systemPrompt`. The autonomous-writing loop
   * sets this: it rebuilds a *fresh* per-chapter digest each iteration and
   * passes it via the chapter user-prompt, so leaving memory in the (once-built,
   * frozen) system prompt would send it twice — and the system copy would be a
   * stale snapshot from the request start. Knowledge + persona/style stay.
   */
  excludeRollingMemory?: boolean;
  /**
   * Curated catalog id (wave 4 commit F). Reserved for the engine-side ctx
   * resolution chain — passing it here lets the resolution helper look up
   * `catalog[modelId].contextLengthTokens` without re-imported deps.
   */
  modelCatalogId?: string;
  /** Style reference entry id (wave 4 vault-backed style picker). */
  styleId?: string;
  /**
   * Optional hint for the embedding endpoint (W2-C recall fallback). When
   * omitted, recall uses the desktop loopback ambient resolver, which returns
   * null outside the bundled desktop embedding path.
   */
  embeddingHint?: EmbeddingEndpointHint | null;
}

export interface AIContextBudgetReport {
  op: AIOpKind;
  knowledgeChars: number;
  memoryChars: number;
  conversationChars: number;
  totalChars: number;
  estTokens: number;
  ctxTokens: number;
  pressure: ContextPressure;
  /** True when the assembler compressed earlier digest to fit. */
  compressed: boolean;
}

export interface AIContextResult {
  novel: Novel;
  systemPrompt: string;
  knowledgeBlock: string;
  memoryBlock: string;
  conversationDigest: string;
  /** Convenience: the legacy "knowledgeSummaries" string for callers that still
   *  consume that name (unify/start-writing pass it to validateChapter). */
  knowledgeSummaries: string;
  budget: AIContextBudgetReport;
}

const PROMPT_OVERHEAD_CHARS = 4_000;
// The output reservation must cover the longest single completion this
// builder ever feeds: streamChapter targets 5000 words ≈ 8000 tokens. The
// previous 2048 ceiling assumed short edits and over-budgeted the prompt
// for chapter drafts, so the context-pressure heuristic would label a
// long-form draft "ok" when it was about to spill on output. 6000 mirrors
// the maxOutputTokensForWords ceiling for a 4000-word slice (≈ the 4-token
// safety margin) and matches what chapter-generator actually requests.
const RESERVED_OUTPUT_TOKENS = 6_000;

/**
 * Build the unified AI context. Returns `null` only when the novel can't be
 * found (matches the old buildNovelSystemPromptFromDB contract so callers can
 * keep the 404 branch unchanged).
 */
export async function buildAIContext(
  args: BuildAIContextArgs,
): Promise<AIContextResult | null> {
  const locale = normalizeLocale(args.locale);
  const budget = OP_BUDGETS[args.op];
  const styleId = normalizeStyleId(args.styleId);
  let knowledgeRowsPromise: Promise<Awaited<ReturnType<typeof getKnowledgeEntries>>> | null = null;
  const loadKnowledgeRows = () => {
    knowledgeRowsPromise ??= getKnowledgeEntries(args.novelId);
    return knowledgeRowsPromise;
  };
  const loadChapters =
    (!args.excludeRollingMemory && needsChapterTails(args.op)) ||
    needsCurrentChapter(args.op, args.focus);
  const loadVolumes = !args.excludeRollingMemory && needsVolumes(args.op);

  // ── Load novel + raw inputs in parallel ───────────────────────────────
  const [novel, chapters, volumes] = await Promise.all([
    args.novel ?? getNovel(args.novelId),
    loadChapters ? getChapters(args.novelId) : Promise.resolve([] as Chapter[]),
    loadVolumes ? getVolumeSummaries(args.novelId) : Promise.resolve([] as VolumeSummary[]),
  ]);
  if (!novel) return null;

  // ── Knowledge block ───────────────────────────────────────────────────
  //
  // W2-C: try the FS-backed recall pipeline first. It reads the SQLite
  // `knowledge_index` mirror (populated by W2-B once the user migrates), runs
  // structured name/wikilink/timeline matching, and only falls back to embedding
  // cosine when budget remains. Any throw or empty result drops us to the
  // legacy `buildSummaryInjection` over `knowledge_entries` so the
  // chapter still drafts. We never want a recall hiccup to block writing.
  let knowledgeBlock = '';
  try {
    const recall = await recallKnowledgeForChapter({
      novelId: args.novelId,
      chapterNumber: args.focus?.chapterNumber,
      extraQueryText: pickExtraQueryText(args),
      budgetChars: budget.knowledgeChars,
      locale,
      embeddingHint: args.embeddingHint ?? null,
    });
    knowledgeBlock = recall.block;
  } catch (err) {
    console.warn('[ai-context-builder] recallKnowledgeForChapter failed, falling back to legacy injection', err);
    knowledgeBlock = '';
  }
  if (!knowledgeBlock) {
    const entries = (await loadKnowledgeRows())
      .filter(r => r.summary && r.summary !== '')
      .map(r => parseKnowledgeEntry(r as unknown as Record<string, unknown>));
    knowledgeBlock = buildSummaryInjection(entries, budget.knowledgeChars);
  }

  // ── Style reference (optional) ────────────────────────────────────────
  const styleRows = styleId
    ? ((await loadKnowledgeRows()) as unknown as Array<Record<string, unknown>>)
    : [];
  const styleReference = resolveStyleReference(
    styleRows,
    styleId,
  );

  // ── Memory block (rolling digest + volume summaries) ──────────────────
  const memorySources = buildDigestSources(chapters);
  const { recentWindow, tailCharsPerChapter } = resolveDigestParams(
    args.op,
    novel,
    memorySources.length,
  );
  const usableVolumes = selectVolumeSummaries(volumes, budget.volumeSummaries);
  const digest = (!args.excludeRollingMemory && (recentWindow > 0 || usableVolumes.length > 0))
    ? buildRollingDigest(memorySources, recentWindow, tailCharsPerChapter, {
        volumeSummaries: usableVolumes,
      })
    : { recentTails: '', earlierDigest: '' };

  // For ops that need just the *current* chapter content (edit), inject that
  // text into memoryBlock so downstream prompt assembly can reference it
  // without a second fetch.
  const currentChapter = needsCurrentChapter(args.op, args.focus)
    ? chapters.find(c => c.chapterNumber === args.focus?.chapterNumber) ?? null
    : null;

  let recentTails = digest.recentTails;
  let earlierDigest = digest.earlierDigest;

  let memoryBlock = composeMemoryBlock({
    locale,
    earlierDigest,
    recentTails,
    currentChapter: currentChapter
      ? { chapterNumber: currentChapter.chapterNumber, title: currentChapter.title, content: truncate(currentChapter.content, budget.knowledgeChars) }
      : null,
    selectionTail: args.focus?.selectionTail,
    selectedText: args.focus?.selectedText,
  });

  // ── Conversation digest ───────────────────────────────────────────────
  let conversationDigest = '';
  if (budget.conversationDigestChars > 0) {
    try {
      conversationDigest = await summarizeConversationsForContext(args.novelId, {
        userId: novel.userId,
        topics: budget.conversationTopics.length > 0 ? budget.conversationTopics : undefined,
        maxChars: budget.conversationDigestChars,
      });
    } catch (err) {
      console.warn('[ai-context-builder] conversation digest failed', err);
      conversationDigest = '';
    }
  }

  // ── Token budget + pressure ───────────────────────────────────────────
  const ctxTokens = resolveCtxTokens(args.modelCtxTokens);
  let compressed = false;
  let totalChars = sum(knowledgeBlock.length, memoryBlock.length, conversationDigest.length, promptReserveChars(args, novel));
  let estTokens = estimateContextTokens(knowledgeBlock, memoryBlock, conversationDigest, args, novel);
  let pressure = classifyPressure(estTokens, ctxTokens);

  if (pressure !== 'ok') {
    // Compress in this order:
    //   1. Drop conversation digest entirely.
    //   2. Compress earlierDigest (replace with first-paragraph + bullet of
    //      character/place rollups if any) — recentTails stays intact for
    //      narrative continuity.
    //   3. Hard-cap knowledge to half its original budget.
    if (conversationDigest) {
      conversationDigest = '';
      compressed = true;
    }
    if (earlierDigest) {
      earlierDigest = compressEarlierDigest(earlierDigest);
      memoryBlock = composeMemoryBlock({
        locale,
        earlierDigest,
        recentTails,
        currentChapter: currentChapter
          ? { chapterNumber: currentChapter.chapterNumber, title: currentChapter.title, content: truncate(currentChapter.content, Math.floor(budget.knowledgeChars / 2)) }
          : null,
        selectionTail: args.focus?.selectionTail,
        selectedText: args.focus?.selectedText,
      });
      compressed = true;
    }
    totalChars = sum(knowledgeBlock.length, memoryBlock.length, conversationDigest.length, promptReserveChars(args, novel));
    estTokens = estimateContextTokens(knowledgeBlock, memoryBlock, conversationDigest, args, novel);
    pressure = classifyPressure(estTokens, ctxTokens);

    if (pressure === 'over' && knowledgeBlock.length > Math.floor(budget.knowledgeChars / 2)) {
      knowledgeBlock = truncate(knowledgeBlock, Math.floor(budget.knowledgeChars / 2));
      compressed = true;
      totalChars = sum(knowledgeBlock.length, memoryBlock.length, conversationDigest.length, promptReserveChars(args, novel));
      estTokens = estimateContextTokens(knowledgeBlock, memoryBlock, conversationDigest, args, novel);
      pressure = classifyPressure(estTokens, ctxTokens);
    }

    if (pressure === 'over' && recentTails.length > 0) {
      recentTails = truncateKeepingTail(recentTails, Math.floor(recentTails.length / 2));
      memoryBlock = composeMemoryBlock({
        locale,
        earlierDigest,
        recentTails,
        currentChapter: currentChapter
          ? { chapterNumber: currentChapter.chapterNumber, title: currentChapter.title, content: truncate(currentChapter.content, Math.floor(budget.knowledgeChars / 2)) }
          : null,
        selectionTail: args.focus?.selectionTail,
        selectedText: args.focus?.selectedText,
      });
      compressed = true;
      totalChars = sum(knowledgeBlock.length, memoryBlock.length, conversationDigest.length, promptReserveChars(args, novel));
      estTokens = estimateContextTokens(knowledgeBlock, memoryBlock, conversationDigest, args, novel);
      pressure = classifyPressure(estTokens, ctxTokens);
    }
  }

  // ── Assemble final systemPrompt ───────────────────────────────────────
  const combinedKnowledge = composeSystemKnowledge({
    locale,
    knowledgeBlock,
    memoryBlock,
    conversationDigest,
  });
  const systemPrompt = assembleSystemPrompt({
    novelTitle: novel.title,
    novelGenre: novel.genre,
    knowledgeSummaries: combinedKnowledge,
    styleReference,
    language: locale,
  });

  return {
    novel,
    systemPrompt,
    knowledgeBlock,
    memoryBlock,
    conversationDigest,
    knowledgeSummaries: combinedKnowledge,
    budget: {
      op: args.op,
      knowledgeChars: knowledgeBlock.length,
      memoryChars: memoryBlock.length,
      conversationChars: conversationDigest.length,
      totalChars,
      estTokens,
      ctxTokens,
      pressure,
      compressed,
    },
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Distil a freeform string the recall NER can mine for character/world names.
 * Each op contributes a slightly different signal:
 *   - continue → trailing chunk of contextBefore (already on `selectionTail`)
 *   - edit/rewrite → the selected text the user is working on
 *   - chat → focus.conversationId can't be inlined synchronously, but the
 *     route also passes `extraEntities` for any hot topic words; we just join
 *     those.
 *   - chapter/outline/unify → no freeform signal; outline frontmatter alone
 *     is enough.
 */
function pickExtraQueryText(args: BuildAIContextArgs): string {
  const f = args.focus;
  if (!f) return '';
  const parts: string[] = [];
  if (f.selectedText) parts.push(f.selectedText);
  if (f.selectionTail) parts.push(f.selectionTail);
  if (f.extraEntities && f.extraEntities.length > 0) parts.push(f.extraEntities.join(' '));
  return parts.join('\n');
}

function needsChapterTails(op: AIOpKind): boolean {
  const b = OP_BUDGETS[op];
  return b.recentWindow === 'adaptive' || (typeof b.recentWindow === 'number' && b.recentWindow > 0);
}

function needsCurrentChapter(op: AIOpKind, focus?: BuildAIContextFocus): boolean {
  return op === 'edit' && typeof focus?.chapterNumber === 'number';
}

function needsVolumes(op: AIOpKind): boolean {
  return OP_BUDGETS[op].volumeSummaries !== 'none';
}

function buildDigestSources(chapters: Chapter[]): RollingDigestSource[] {
  return chapters.map(c => ({
    chapterNumber: c.chapterNumber,
    title: c.title,
    content: c.content,
    summary: c.summary || '',
    summaryStale: c.generationMeta?.summaryStale === true,
    keyFacts: c.keyFacts ?? null,
  }));
}

function resolveDigestParams(
  op: AIOpKind,
  novel: Novel,
  chapterCount: number,
): { recentWindow: number; tailCharsPerChapter: number } {
  const b = OP_BUDGETS[op];
  if (b.recentWindow === 'adaptive' || b.tailCharsPerChapter === 'adaptive') {
    try {
      const params = adaptiveDigestParams(novel.targetWords || 80_000, chapterCount);
      return {
        recentWindow: b.recentWindow === 'adaptive' ? params.recentWindow : b.recentWindow,
        tailCharsPerChapter: b.tailCharsPerChapter === 'adaptive'
          ? params.tailCharsPerChapter
          : b.tailCharsPerChapter,
      };
    } catch (err) {
      console.warn('[ai-context-builder] adaptiveDigestParams threw, falling back', err);
      return { recentWindow: 2, tailCharsPerChapter: 1500 };
    }
  }
  return {
    recentWindow: b.recentWindow,
    tailCharsPerChapter: b.tailCharsPerChapter,
  };
}

function selectVolumeSummaries(
  all: VolumeSummary[],
  policy: OpBudget['volumeSummaries'],
): VolumeSummary[] {
  if (!all.length || policy === 'none') return [];
  if (policy === 'all') return all;
  const sorted = [...all].sort((a, b) => a.start - b.start);
  return sorted.slice(-Math.max(0, policy.lastN));
}

function resolveStyleReference(
  rows: Array<Record<string, unknown>>,
  styleId: string | null,
): StyleReferenceData | null {
  if (!styleId) return null;
  const row = rows.find(r => (r.id as string) === styleId);
  if (!row) return null;
  try {
    const entry = parseKnowledgeEntry(row as Record<string, unknown>);
    if (entry.type !== 'style_reference') return null;
    return (entry as StyleReferenceEntry).data;
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

// Keep the END of the string, not the start. Used for recentTails under
// pressure: `buildRollingDigest` deliberately keeps each chapter's *ending*
// (continuity depends on it) and orders chapters oldest→newest, so a head cut
// would throw away the most-recent chapter's ending first — inverting the
// recency priority the whole pipeline is built around.
function truncateKeepingTail(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return `…${s.slice(s.length - Math.max(0, max - 1))}`;
}

function sum(...nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

function promptReserveChars(args: BuildAIContextArgs, novel: Novel): number {
  return PROMPT_OVERHEAD_CHARS + promptReserveText(args, novel).length;
}

function promptReserveText(args: BuildAIContextArgs, novel: Novel): string {
  return [
    novel.title,
    novel.genre,
    novel.storySummary,
    novel.characterSummary,
    novel.arcSummary,
    args.focus?.selectionTail ?? '',
    args.focus?.selectedText ?? '',
    args.focus?.extraEntities?.join(' ') ?? '',
  ].join('\n');
}

function estimatePromptReserveTokens(args: BuildAIContextArgs, novel: Novel): number {
  return Math.ceil(PROMPT_OVERHEAD_CHARS / 4) + estimateTokens(promptReserveText(args, novel));
}

function estimateContextTokens(
  knowledgeBlock: string,
  memoryBlock: string,
  conversationDigest: string,
  args: BuildAIContextArgs,
  novel: Novel,
): number {
  return (
    estimateTokens(knowledgeBlock) +
    estimateTokens(memoryBlock) +
    estimateTokens(conversationDigest) +
    estimatePromptReserveTokens(args, novel) +
    RESERVED_OUTPUT_TOKENS
  );
}

function composeMemoryBlock(input: {
  locale: Locale;
  earlierDigest: string;
  recentTails: string;
  currentChapter: { chapterNumber: number; title: string; content: string } | null;
  selectionTail?: string;
  selectedText?: string;
}): string {
  const isZh = isZhLocale(input.locale);
  const parts: string[] = [];
  if (input.earlierDigest) {
    parts.push(isZh ? '【前情摘要】' : '[Earlier digest]');
    parts.push(input.earlierDigest);
  }
  if (input.recentTails) {
    parts.push(isZh ? '【最近章节结尾】' : '[Recent chapter tails]');
    parts.push(input.recentTails);
  }
  if (input.currentChapter) {
    parts.push(isZh
      ? `【当前章节 第${input.currentChapter.chapterNumber}章 ${input.currentChapter.title}】`
      : `[Current chapter ${input.currentChapter.chapterNumber} — ${input.currentChapter.title}]`);
    parts.push(input.currentChapter.content);
  }
  if (input.selectionTail) {
    parts.push(isZh ? '【光标前文】' : '[Text before cursor]');
    parts.push(input.selectionTail);
  }
  if (input.selectedText) {
    parts.push(isZh ? '【选中片段】' : '[Selected text]');
    parts.push(input.selectedText);
  }
  return parts.join('\n');
}

function composeSystemKnowledge(input: {
  locale: Locale;
  knowledgeBlock: string;
  memoryBlock: string;
  conversationDigest: string;
}): string {
  const isZh = isZhLocale(input.locale);
  const sections: string[] = [];
  if (input.knowledgeBlock.trim()) {
    sections.push(input.knowledgeBlock);
  }
  if (input.memoryBlock.trim()) {
    sections.push(isZh ? '--- 创作记忆 ---' : '--- Story memory ---');
    sections.push(input.memoryBlock);
  }
  if (input.conversationDigest.trim()) {
    sections.push(isZh ? '--- 历史讨论摘要 ---' : '--- Prior discussion ---');
    sections.push(input.conversationDigest);
  }
  return sections.join('\n');
}

function compressEarlierDigest(text: string): string {
  // Keep only rollup lines (Characters seen / Places seen / Items seen) +
  // the first 600 chars of detail — drops the per-chapter blow-by-blow.
  const lines = text.split('\n');
  const rollups: string[] = [];
  const details: string[] = [];
  for (const line of lines) {
    if (/^(Characters seen|Places seen|Items seen):/i.test(line)) {
      rollups.push(line);
    } else {
      details.push(line);
    }
  }
  const detailJoined = details.join('\n');
  const detailCap = 600;
  const detail = detailJoined.length > detailCap
    ? `${detailJoined.slice(0, detailCap)}…`
    : detailJoined;
  return [rollups.join('\n'), detail].filter(Boolean).join('\n');
}

function resolveCtxTokens(modelCtxTokens: number | undefined): number {
  if (modelCtxTokens && modelCtxTokens > 0) return modelCtxTokens;
  return FALLBACK_CTX_TOKENS;
}
