// Post-import AI knowledge extraction (W2-1). SERVER-ONLY.
//
// After a manuscript lands as chapters, this OPTIONAL, ASYNC pass asks the
// recall-class model to mine the prose for knowledge-base entries (characters /
// world / timeline) plus one style_reference profile, then writes them via the
// same `createKnowledgeEntry` path the manual KB form uses. Everything degrades:
//
//   - no model bound / network down  → returns `failed`, writes nothing, never
//                                       throws to the caller's import flow.
//   - a single chunk errors          → that chunk is skipped, others proceed.
//   - user cancels (AbortSignal)     → returns `cancelled`; partial entries that
//                                       already committed stay (they're valid).
//
// The detector + chapter write are the load-bearing import; THIS is best-effort
// enrichment. importMeta.kbExtraction tracks pending → done|failed.

import type { LanguageModel } from 'ai';

import { extractEntryFromMessageResult } from '@/lib/ai/conversation-extract';
import { extractStyleNotesResult, formatStyleNotes } from '@/lib/ai/style-extractor';
import { createKnowledgeEntry } from '@/app/actions/knowledge';
import {
  createKnowledgeEntrySchema,
  type KnowledgeType,
} from '@/lib/types/knowledge';
import type { ExtractedEntry } from '@/lib/ai/conversation-extract';

export type KbExtractionOutcome = 'done' | 'failed' | 'cancelled';

export interface ExtractKnowledgeArgs {
  novelId: string;
  /** Chapter prose in order. We sample, not exhaustively scan — see SAMPLE_*. */
  chapters: { title: string; content: string }[];
  model: LanguageModel;
  locale?: string;
  signal?: AbortSignal;
}

export interface ExtractKnowledgeResult {
  outcome: KbExtractionOutcome;
  /** Count of knowledge entries actually written (across all types). */
  created: number;
}

// We don't feed an entire novel to a small recall model. Sample the opening of
// the first few chapters (where characters/world are introduced) into bounded
// chunks, plus a dedicated style sample from chapter 1.
const MAX_SAMPLE_CHAPTERS = 6;
const CHUNK_CHARS = 3_500;
const STYLE_SAMPLE_CHARS = 4_000;
const MAX_ENTRIES = 24;

class AbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

/**
 * Build the prose chunks fed to the entry extractor. Each chunk is a labeled
 * slice of one chapter's opening so the model has chapter context. Bounded by
 * MAX_SAMPLE_CHAPTERS so a 200-chapter import still runs in seconds.
 */
export function buildSampleChunks(
  chapters: { title: string; content: string }[],
): string[] {
  const chunks: string[] = [];
  for (const ch of chapters.slice(0, MAX_SAMPLE_CHAPTERS)) {
    const body = ch.content.trim();
    if (body.length < 40) continue;
    const slice = body.slice(0, CHUNK_CHARS);
    const label = ch.title ? `【${ch.title}】\n` : '';
    chunks.push(`${label}${slice}`);
  }
  return chunks;
}

/**
 * Coerce a loosely-extracted entry into the strict `createKnowledgeEntry`
 * schema. The conversation extractor returns a permissive `data` bag; the KB
 * create path validates against per-type discriminated unions. We fill the
 * required discriminator fields each type needs (character.role,
 * timeline.dateSort/eventType, world.category, outline.chapterNumber) with safe
 * defaults so a sparse extraction still saves rather than throwing.
 */
export function coerceEntryInput(entry: ExtractedEntry):
  | { type: KnowledgeType; title: string; tags: string[]; data: Record<string, unknown> }
  | null {
  const title = (entry.title ?? '').trim();
  if (!title) return null; // an entry with no name is noise — skip it.

  const data = (entry.data ?? {}) as Record<string, unknown>;
  const summary = (entry.summary ?? '').trim();

  switch (entry.type) {
    case 'character':
      return {
        type: 'character',
        title,
        tags: [],
        data: {
          role: coerceEnum(data.role, ['protagonist', 'antagonist', 'supporting', 'minor'], 'supporting'),
          description: str(data.description) || summary,
          backstory: str(data.backstory),
          motivation: str(data.motivation),
          traits: strList(data.traits),
          arc: str(data.arc),
        },
      };
    case 'world':
      return {
        type: 'world',
        title,
        tags: [],
        data: {
          category: coerceEnum(
            data.category,
            ['location', 'faction', 'magic_system', 'technology', 'culture', 'rule', 'item'],
            'location',
          ),
          description: str(data.description) || summary,
          details: {},
        },
      };
    case 'timeline':
      return {
        type: 'timeline',
        title,
        tags: [],
        data: {
          date: str(data.date),
          dateSort: typeof data.dateSort === 'number' ? data.dateSort : 0,
          eventType: coerceEnum(data.eventType, ['plot', 'character', 'world', 'backstory'], 'plot'),
          description: str(data.description) || summary,
          chapterIds: [],
          characterRefs: [],
          importance: coerceEnum(data.importance, ['major', 'minor'], 'minor'),
        },
      };
    // outline / style_reference are produced by dedicated paths, not the generic
    // entry extractor — skip them here to avoid double-writing.
    default:
      return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
}
function coerceEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Run the extraction. Always resolves (never rejects) — the outcome field
 * carries success/failure so the caller can set importMeta.kbExtraction without
 * a try/catch. A user-initiated abort resolves with `cancelled`.
 */
export async function extractKnowledgeFromManuscript(
  args: ExtractKnowledgeArgs,
): Promise<ExtractKnowledgeResult> {
  let created = 0;
  // Track persistence failures separately from validation skips. A total
  // persistence outage (e.g. DB locked/disk full on every entry) used to be
  // reported as outcome:'done' with created:0 — silent false-success. When
  // every attempted write failed and nothing was created, surface 'failed'.
  let persistFailures = 0;
  let attemptedWrites = 0;
  // Dedup by (type,title) so the same character introduced across two sampled
  // chapters isn't written twice.
  const seen = new Set<string>();

  /** Apply one tryCreate result to the running counters. */
  const apply = (res: TryCreateResult) => {
    if (res.status === 'created') created++;
    else if (res.status === 'persist-failed') {
      persistFailures++;
      attemptedWrites++;
    }
    // 'skipped' (validation error) is a safe no-op for a single bad entry.
  };

  try {
    // 1. Style reference from the opening prose.
    throwIfAborted(args.signal);
    const styleSample = args.chapters
      .map(c => c.content)
      .join('\n\n')
      .slice(0, STYLE_SAMPLE_CHARS);
    const styleResult = await extractStyleNotesResult({
      sampleText: styleSample,
      model: args.model,
      locale: args.locale,
      signal: args.signal,
    });
    if (styleResult.ok) {
      const notes = formatStyleNotes(styleResult.notes, args.locale);
      if (notes.trim()) {
        const input = {
          type: 'style_reference' as const,
          title: deriveStyleTitle(args.locale),
          tags: [],
          data: {
            sampleText: styleSample.slice(0, 5_000),
            styleNotes: notes.slice(0, 2_000),
            source: 'imported manuscript',
          },
        };
        apply(await tryCreate(args.novelId, input));
      }
    }

    // 2. Character / world / timeline entries from sampled chunks.
    const chunks = buildSampleChunks(args.chapters);
    for (const chunk of chunks) {
      throwIfAborted(args.signal);
      if (created >= MAX_ENTRIES) break;
      const result = await extractEntryFromMessageResult({
        messageContent: chunk,
        model: args.model,
        locale: args.locale,
        signal: args.signal,
      });
      if (!result.ok) continue;
      const coerced = coerceEntryInput(result.entry);
      if (!coerced) continue;
      const key = `${coerced.type}:${coerced.title.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      apply(await tryCreate(args.novelId, coerced));
    }

    // If nothing was created AND every attempted write failed at the persistence
    // layer (not validation), the extraction did not silently succeed — surface
    // 'failed' so the caller can retry/alert instead of showing "0 entries".
    if (created === 0 && attemptedWrites > 0 && persistFailures === attemptedWrites) {
      return { outcome: 'failed', created };
    }
    return { outcome: 'done', created };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { outcome: 'cancelled', created };
    }
    // Any other failure → degrade. Partial entries already written stay.
    return { outcome: 'failed', created };
  }
}

type TryCreateResult = { status: 'created' } | { status: 'skipped' } | { status: 'persist-failed' };

/** Validate against the strict schema and create. A validation failure (bad
 *  entry shape) returns 'skipped' so one bad entry never aborts the whole
 *  extraction. A persistence failure (DB/IO) returns 'persist-failed' so the
 *  caller can detect a total outage instead of a silent 0-created 'done'. */
async function tryCreate(novelId: string, input: unknown): Promise<TryCreateResult> {
  let parsed: unknown;
  try {
    parsed = createKnowledgeEntrySchema.parse(input);
  } catch {
    // Validation error — this single entry is bad; skip it and keep going.
    return { status: 'skipped' };
  }
  try {
    await createKnowledgeEntry(novelId, parsed);
    return { status: 'created' };
  } catch {
    // Persistence error — distinct from a validation skip so a total outage
    // is not masked as an empty success.
    return { status: 'persist-failed' };
  }
}

function deriveStyleTitle(locale?: string): string {
  return (locale ?? '').startsWith('zh') ? '导入稿件的风格参考' : 'Imported manuscript style';
}
