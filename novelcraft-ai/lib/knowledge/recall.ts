// Wave 2 commit C — FS-backed knowledge recall.
//
// Replaces the legacy `buildSummaryInjection(entries, budgetChars)` "dump
// every entry's summary line" approach with a chapter-aware, structured pass:
//
//   1. Collect candidate names from the outline entry + freeform query text.
//   2. Look those names up in the `knowledge_index` (titles + aliases).
//   3. 1-hop wikilink expansion: for each matched character, take entries it
//      links to in its body and add them to the pool.
//   4. Timeline entries that mention the current chapter id / number.
//   5. If budget remains, run a cosine search over `knowledge_embeddings`
//      using the outline synopsis + key events as the query.
//   6. Render each pool group with the structured renderers (render.ts).
//
// Any error in this chain throws back to the caller (buildAIContext), which
// catches and falls back to the legacy summary injection so a one-off failure
// in the new pipeline never blocks a chapter draft.

import {
  listKnowledgeIndexForNovel,
  matchKnowledgeIndexByNames,
  matchTimelineByChapterIds,
  matchTimelineByChapterNumber,
  getOutlineIndexForChapter,
} from '@/lib/db/queries-knowledge-vault';
import {
  renderCharacterBlock,
  renderTimelineBlock,
  renderWorldGroup,
  renderOutlineNeighbor,
} from '@/lib/knowledge/render';
import {
  searchSimilarEntries,
  type EmbeddingEndpointHint,
} from '@/lib/knowledge/embedding';
import { refreshKnowledgeIndexForEntry } from '@/lib/knowledge/refresh-index';
import { getKnowledgeEntriesByNovel } from '@/lib/db/queries-knowledge';
import type { Locale } from '@/lib/i18n';
import type { KnowledgeType } from '@/lib/types/knowledge';
import type { VaultIndexRow } from '@/lib/vault/types';

export interface RecallArgs {
  novelId: string;
  /** Chapter being drafted/edited/discussed (1-based). */
  chapterNumber?: number;
  /** Outline projection for `chapterNumber` — when omitted we look it up. */
  outlineEntry?: VaultIndexRow | null;
  /**
   * Freeform text to add to the candidate-name extractor. For:
   *   continue → contextBefore.slice(-2000)
   *   edit     → selectedText
   *   chat     → conversation topic / last user message
   */
  extraQueryText?: string;
  budgetChars: number;
  locale?: Locale;
  /** Hint for the embedding endpoint; null disables the embedding fallback. */
  embeddingHint?: EmbeddingEndpointHint | null;
}

export interface RecallResult {
  /** Grouped entries the renderer actually included. */
  blocks: { type: KnowledgeType; entries: VaultIndexRow[] }[];
  /** Concatenated markdown ready to drop into the prompt. */
  block: string;
  /** True when at least one entry was added via embedding cosine. */
  usedEmbedding: boolean;
  charsUsed: number;
}

const BLOCK_SEP = '\n\n';

/**
 * Resolve knowledge for a chapter using the FS-backed pipeline.
 *
 * Throws on internal errors. Caller may fall back to summary injection.
 */
// Memoize ONLY novels confirmed to have no knowledge at all (both the index
// and the canonical table empty). That's the sole safe thing to cache: a
// genuinely empty novel won't sprout entries without a write path, and any
// write repopulates the index so this short-circuit is bypassed.
//
// We deliberately do NOT cache "backfill already attempted". If the index is
// later emptied — vault hand-edit, test reset, local corruption — while the
// canonical knowledge table still holds rows, recall must re-run the cheap
// in-process SQLite rebuild rather than return an empty knowledge block for the
// entire life of the Tauri process.
const knownEmptyNovels = new Set<string>();

export async function recallKnowledgeForChapter(
  args: RecallArgs,
): Promise<RecallResult> {
  const locale = args.locale ?? 'en';
  const budget = Math.max(0, args.budgetChars);
  // Lazy rebuild: when the index is empty but knowledge entries exist, populate
  // the index in place so recall starts working immediately.
  let allIndex = await listKnowledgeIndexForNovel(args.novelId);
  if (allIndex.length === 0 && !knownEmptyNovels.has(args.novelId)) {
    try {
      const rebuiltCount = await rebuildIndexFromKnowledgeEntries(args.novelId);
      if (rebuiltCount === 0) {
        // No index AND no entries means genuinely empty. Cache it so we don't
        // rescan on every AI call.
        knownEmptyNovels.add(args.novelId);
      } else {
        // Entries existed: re-read the now-populated index. We intentionally do
        // not memoize here so a future empty-index state retries the rebuild.
        allIndex = await listKnowledgeIndexForNovel(args.novelId);
      }
    } catch (err) {
      console.warn('[recall] index backfill failed', err);
    }
  }
  if (allIndex.length === 0) {
    return { blocks: [], block: '', usedEmbedding: false, charsUsed: 0 };
  }
  const allIndexById = new Map(allIndex.map(row => [row.id, row]));

  const outlineEntry = await resolveOutlineEntry(args);

  // ── 1. Candidate names ──────────────────────────────────────────────────
  const indexedNameSet = new Set(
    allIndex
      .filter(r => r.type === 'character' || r.type === 'world')
      .flatMap(r => [r.title, ...r.aliases]),
  );
  const candidateNames = collectCandidateNames({
    outlineEntry,
    extraQueryText: args.extraQueryText,
    indexedNameSet,
  });

  // ── 2. Index lookup by name (characters + worlds) ───────────────────────
  const charactersHit = candidateNames.length
    ? await matchKnowledgeIndexByNames(args.novelId, candidateNames, 'character')
    : [];
  const worldsHit = candidateNames.length
    ? await matchKnowledgeIndexByNames(args.novelId, candidateNames, 'world')
    : [];

  // ── 3. 1-hop wikilink expansion (character body links to character/world) ─
  const hop1Map = new Map<string, VaultIndexRow[]>(); // sourceId → hop1 entries
  const seenIds = new Set<string>([...charactersHit, ...worldsHit].map(r => r.id));
  for (const character of charactersHit) {
    const hops: VaultIndexRow[] = [];
    for (const link of character.outgoingLinks) {
      // Prefer resolvedId when the index walker hydrated it. Otherwise resolve
      // by title via the listing we already have in memory (no extra query).
      let target: VaultIndexRow | null = null;
      if (link.resolvedId) {
        target = allIndexById.get(link.resolvedId) ?? null;
        if (target?.novelId !== args.novelId) {
          target = null;
        }
      }
      if (!target) {
        target = findByTitle(allIndex, link.raw);
      }
      if (target && !seenIds.has(target.id)) {
        seenIds.add(target.id);
        hops.push(target);
      }
    }
    if (hops.length > 0) hop1Map.set(character.id, hops);
  }
  const hop1Pool = Array.from(hop1Map.values()).flat();
  // Split hop1 results by type so they render alongside the original groups.
  const hop1Characters = hop1Pool.filter(r => r.type === 'character');
  const hop1Worlds = hop1Pool.filter(r => r.type === 'world');

  // ── 4. Timeline by current chapter id / number ──────────────────────────
  const timelineHits: VaultIndexRow[] = [];
  const chapterIdHint = typeof outlineEntry?.data['chapterId'] === 'string'
    ? (outlineEntry.data['chapterId'] as string)
    : '';
  if (chapterIdHint) {
    const t = await matchTimelineByChapterIds(args.novelId, [chapterIdHint]);
    for (const row of t) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        timelineHits.push(row);
      }
    }
  }
  if (timelineHits.length === 0 && typeof args.chapterNumber === 'number') {
    const t = await matchTimelineByChapterNumber(args.novelId, args.chapterNumber);
    for (const row of t) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        timelineHits.push(row);
      }
    }
  }

  // ── 5. High-importance safety net ───────────────────────────────────────
  // Keyword/structured recall only surfaces entities literally named in this
  // chapter's outline/query. A character introduced 20 chapters ago and now
  // referenced only by pronoun would be missed — especially in the common
  // no-embedding-model setup. Cheap fix: always fold in `importance: 'high'`
  // entries for the novel (deduped against what we already matched). The final
  // render's budget still bounds how many actually land in the prompt.
  const importantCharacters: VaultIndexRow[] = [];
  const importantWorlds: VaultIndexRow[] = [];
  for (const row of allIndex) {
    if (row.importance !== 'high' || seenIds.has(row.id)) continue;
    if (row.type === 'character') {
      seenIds.add(row.id);
      importantCharacters.push(row);
    } else if (row.type === 'world') {
      seenIds.add(row.id);
      importantWorlds.push(row);
    }
  }

  const characterPool = dedupe([...charactersHit, ...hop1Characters, ...importantCharacters]);
  const worldPool = dedupe([...worldsHit, ...hop1Worlds, ...importantWorlds]);

  // ── 6. Embedding fallback (only if budget headroom remains) ──────────────
  let usedEmbedding = false;
  const embeddingHits: VaultIndexRow[] = [];
  // Render the structured pass ONCE, *with* budget, and measure leftover
  // headroom. Gating the embedding fetch on the un-truncated size (the old
  // behaviour) wasted a network round-trip whenever structured matches nearly
  // filled the budget — the budgeted final render would then drop the very
  // embedding hits we paid to fetch. Only fetch when a useful block can fit.
  const MIN_USEFUL_BLOCK = 400; // ~one trimmed entry block; below this, skip the fetch.
  const structured = renderAll({
    locale,
    outlineEntry,
    characters: characterPool,
    worlds: worldPool,
    timeline: timelineHits,
    embeddings: [],
    hop1Map,
    budget,
  });
  const remaining = budget - structured.length;
  if (remaining > MIN_USEFUL_BLOCK && args.embeddingHint) {
    try {
      const query = buildEmbeddingQuery(outlineEntry, args.extraQueryText);
      if (query) {
        const k = 5;
        const hits = await searchSimilarEntries(args.novelId, query, k, args.embeddingHint);
        for (const h of hits) {
          if (seenIds.has(h.entryId)) continue;
          const row = allIndexById.get(h.entryId);
          if (!row || row.novelId !== args.novelId) continue;
          embeddingHits.push(row);
          seenIds.add(row.id);
        }
        if (embeddingHits.length > 0) usedEmbedding = true;
      }
    } catch (err) {
      // Swallow — embedding is a best-effort additive step.
      console.warn('[recall] embedding fallback failed', err);
    }
  }

  // ── 7. Final render with budget enforcement ─────────────────────────────
  // Reuse the structured render when no embedding hits were added — it was
  // already produced with the same inputs + budget above.
  const block = embeddingHits.length === 0
    ? structured
    : renderAll({
        locale,
        outlineEntry,
        characters: characterPool,
        worlds: worldPool,
        timeline: timelineHits,
        embeddings: embeddingHits,
        hop1Map,
        budget,
      });

  // Compose grouped report (for callers / tests that want to introspect).
  const blocks: RecallResult['blocks'] = [];
  pushIfNonEmpty(blocks, 'character', characterPool);
  pushIfNonEmpty(blocks, 'world', worldPool);
  pushIfNonEmpty(blocks, 'timeline', timelineHits);
  pushIfNonEmpty(blocks, 'outline', outlineEntry ? [outlineEntry] : []);
  // Embedding hits land in whatever type they actually are.
  for (const e of embeddingHits) {
    const existing = blocks.find(b => b.type === e.type);
    if (existing) existing.entries.push(e);
    else blocks.push({ type: e.type, entries: [e] });
  }

  return {
    blocks,
    block,
    usedEmbedding,
    charsUsed: block.length,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

async function resolveOutlineEntry(args: RecallArgs): Promise<VaultIndexRow | null> {
  if (args.outlineEntry) return args.outlineEntry;
  if (typeof args.chapterNumber !== 'number') return null;
  return getOutlineIndexForChapter(args.novelId, args.chapterNumber);
}

interface CandidateInputs {
  outlineEntry: VaultIndexRow | null;
  extraQueryText: string | undefined;
  indexedNameSet: Set<string>;
}

/**
 * Lightweight name extraction. We don't run a real NER — this is server-side
 * Node and a 50 MB tokenizer is overkill. Instead:
 *   - Outline frontmatter `characters` / `keyEvents` is already a curated list.
 *   - Freeform query text is tokenized by whitespace + punctuation, and any
 *     token that matches a known character title or alias is added.
 *
 * The indexed name set is built by the caller from the full index so we
 * avoid running it through tokenization.
 */
export function collectCandidateNames(args: CandidateInputs): string[] {
  const names = new Set<string>();
  const fm = args.outlineEntry?.data ?? {};
  const fmCharacters = Array.isArray(fm['characters']) ? (fm['characters'] as string[]) : [];
  for (const name of fmCharacters) {
    if (typeof name === 'string' && name.trim()) names.add(name.trim());
  }
  const keyEvents = Array.isArray(fm['keyEvents']) ? (fm['keyEvents'] as string[]) : [];
  // keyEvents often phrase "陈夏与林夕对峙" — scan for embedded character names.
  for (const evt of keyEvents) {
    if (typeof evt !== 'string') continue;
    for (const known of args.indexedNameSet) {
      if (!known) continue;
      if (containsName(evt, known)) names.add(known);
    }
  }
  // Locations field if present (we treat as candidate world names).
  const locations = Array.isArray(fm['locations']) ? (fm['locations'] as string[]) : [];
  for (const name of locations) {
    if (typeof name === 'string' && name.trim()) names.add(name.trim());
  }
  // Synopsis: scan for known names.
  const synopsis = typeof fm['synopsis'] === 'string' ? (fm['synopsis'] as string) : '';
  if (synopsis) {
    for (const known of args.indexedNameSet) {
      if (!known) continue;
      if (containsName(synopsis, known)) names.add(known);
    }
  }
  // Freeform query: token-based + substring scan against known names.
  if (args.extraQueryText && args.extraQueryText.trim()) {
    const text = args.extraQueryText;
    for (const known of args.indexedNameSet) {
      if (!known) continue;
      if (containsName(text, known)) names.add(known);
    }
  }
  return Array.from(names);
}

function containsName(text: string, name: string): boolean {
  const needle = name.trim();
  if (!needle) return false;
  if (containsCjk(needle)) {
    if (Array.from(needle).length < 2) return false;
    return text.includes(needle);
  }
  if (isLikelySentenceToken(needle)) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text);
}

function isLikelySentenceToken(value: string): boolean {
  return /^(A|An|And|As|At|But|For|From|He|Her|His|I|In|It|Its|Of|On|Or|She|That|The|They|This|To|We|When|Where|With)$/i.test(value);
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findByTitle(pool: VaultIndexRow[], title: string): VaultIndexRow | null {
  const lc = title.toLowerCase();
  for (const r of pool) {
    if (r.title.toLowerCase() === lc) return r;
    for (const alias of r.aliases) {
      if (typeof alias === 'string' && alias.toLowerCase() === lc) return r;
    }
  }
  return null;
}

function dedupe(rows: VaultIndexRow[]): VaultIndexRow[] {
  const seen = new Set<string>();
  const out: VaultIndexRow[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function pushIfNonEmpty(
  blocks: RecallResult['blocks'],
  type: KnowledgeType,
  entries: VaultIndexRow[],
): void {
  if (entries.length > 0) blocks.push({ type, entries });
}

interface RenderInputs {
  locale: Locale;
  outlineEntry: VaultIndexRow | null;
  characters: VaultIndexRow[];
  worlds: VaultIndexRow[];
  timeline: VaultIndexRow[];
  embeddings: VaultIndexRow[];
  hop1Map: Map<string, VaultIndexRow[]>;
  budget?: number;
}

function renderAll(input: RenderInputs): string {
  const pieces: string[] = [];
  let used = 0;
  const budget = input.budget ?? Number.POSITIVE_INFINITY;

  function push(text: string): boolean {
    if (!text) return false;
    const cost = text.length + (pieces.length > 0 ? BLOCK_SEP.length : 0);
    if (used + cost > budget) return false;
    pieces.push(text);
    used += cost;
    return true;
  }

  // Outline neighbor at the top so the model sees "what this chapter is".
  if (input.outlineEntry) {
    push(renderOutlineNeighbor(input.outlineEntry, { locale: input.locale }));
  }

  // Characters (with hop1 relations annotated on the rendered line).
  for (const c of input.characters) {
    const hop1 = input.hop1Map.get(c.id) ?? [];
    const block = renderCharacterBlock(c, { locale: input.locale, hop1 });
    if (!push(block)) break;
  }

  // Worlds grouped by category.
  const byCategory = new Map<string, VaultIndexRow[]>();
  for (const w of input.worlds) {
    const cat = typeof w.data['category'] === 'string' ? (w.data['category'] as string) : 'misc';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(w);
  }
  for (const [cat, entries] of byCategory) {
    if (!push(renderWorldGroup(cat, entries, { locale: input.locale }))) break;
  }

  // Timeline sorted by dateSort ASC where present.
  const timelineSorted = [...input.timeline].sort((a, b) => {
    const da = typeof a.data['dateSort'] === 'number' ? (a.data['dateSort'] as number) : 0;
    const db = typeof b.data['dateSort'] === 'number' ? (b.data['dateSort'] as number) : 0;
    return da - db;
  });
  for (const t of timelineSorted) {
    if (!push(renderTimelineBlock(t, { locale: input.locale }))) break;
  }

  // Embedding hits (rendered as their natural type).
  for (const e of input.embeddings) {
    if (e.type === 'character') {
      if (!push(renderCharacterBlock(e, { locale: input.locale }))) break;
    } else if (e.type === 'world') {
      if (!push(renderWorldGroup('', [e], { locale: input.locale }))) break;
    } else if (e.type === 'timeline') {
      if (!push(renderTimelineBlock(e, { locale: input.locale }))) break;
    } else if (e.type === 'outline') {
      if (!push(renderOutlineNeighbor(e, { locale: input.locale }))) break;
    }
  }

  return pieces.join(BLOCK_SEP);
}

/**
 * Lazy rebuild from `knowledge_entries` into the `knowledge_index` table.
 * Idempotent; re-running just refreshes the rows.
 *
 * Returns the number of entries seen so the caller can distinguish "genuinely
 * empty novel" (0) from "index lost but entries still present" (>0, worth
 * retrying on the next call).
 */
async function rebuildIndexFromKnowledgeEntries(novelId: string): Promise<number> {
  const entries = await getKnowledgeEntriesByNovel(novelId);
  for (const row of entries) {
    await refreshKnowledgeIndexForEntry(row.id, row.updated_at);
  }
  return entries.length;
}

function buildEmbeddingQuery(
  outlineEntry: VaultIndexRow | null,
  extraQueryText: string | undefined,
): string {
  const parts: string[] = [];
  if (outlineEntry) {
    const synopsis = outlineEntry.data['synopsis'];
    if (typeof synopsis === 'string' && synopsis.trim()) parts.push(synopsis.trim());
    const keyEvents = outlineEntry.data['keyEvents'];
    if (Array.isArray(keyEvents)) {
      const arr = keyEvents.filter(v => typeof v === 'string') as string[];
      if (arr.length > 0) parts.push(arr.join(' '));
    }
  }
  if (extraQueryText && extraQueryText.trim()) {
    parts.push(extraQueryText.trim());
  }
  return parts.join('\n').slice(0, 1500);
}
