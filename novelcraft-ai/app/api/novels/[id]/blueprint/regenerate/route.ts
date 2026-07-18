import { NextResponse } from 'next/server';
import {
  acquireWritingLock,
  getChaptersLite,
  getNovel,
  getNovelBlueprint,
  isInStages,
  releaseWritingLock,
  renewWritingLock,
  setNovelBlueprint,
  setNovelBlueprintAfterDeletingChaptersFrom,
  STAGES_THAT_CAN_REGENERATE_BLUEPRINT,
} from '@/lib/db';
import { generateBookBlueprint, getTargetWordsPerChapter, buildNovelLanguageSignals } from '@/lib/ai';
import { buildNovelSystemPromptFromDB } from '@/lib/ai-context';
import { normalizeLocale } from '@/lib/i18n';
import { requireNovelOwner } from '@/lib/local-auth';
import { aiUsageErrorResponse, createAIUsageSession } from '@/lib/ai-usage';
import { detectLanguage, sanitizeError } from '@/lib/utils';
import { parsePositiveIntegerParam } from '@/lib/route-params';
import { resolveEmbeddingEndpointFromRequest } from '@/lib/knowledge/embedding';

const LOCK_TTL_SEC = 600;

export function parseBlueprintFromChapter(searchParams: URLSearchParams): number | null | { error: string } {
  const raw = searchParams.get('fromChapter');
  if (raw === null) return null;
  const parsed = parsePositiveIntegerParam(raw);
  if (parsed === null || parsed < 2) {
    return {
      error: 'fromChapter must be an integer >= 2. For a full rewrite, omit the parameter (only allowed when no chapters exist yet).',
    };
  }
  return parsed;
}

export const runtime = 'nodejs';
export const maxDuration = 300;

// Regenerates the full-book outline. Two modes:
//  - Without `fromChapter`: refuses if any chapter is already drafted (full
//    rewrite would invalidate the rolling-memory digest).
//  - With `?fromChapter=N`: keeps the first N-1 chapters of the existing
//    blueprint as fixed context, re-plans chapters N..end, and drops any
//    drafted chapter >= N from the chapters table.
//
// We achieve "re-plan tail" by feeding the kept-chapters summary into the
// system prompt and post-filtering the AI's response. A more precise
// partial-regen API will land with the outline-as-vault refactor (wave 2).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { user } = ownerCheck;

  const fromChapter = parseBlueprintFromChapter(new URL(request.url).searchParams);
  if (typeof fromChapter === 'object' && fromChapter !== null) {
    return NextResponse.json(
      { error: fromChapter.error },
      { status: 400 },
    );
  }

  const lock = await acquireWritingLock(id, LOCK_TTL_SEC);
  if (!lock) {
    return NextResponse.json(
      { error: 'Another writing session is already in progress for this novel.' },
      { status: 409 },
    );
  }

  try {
    const currentNovel = await getNovel(id);
    if (!currentNovel || currentNovel.userId !== user.id) {
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }
    if (!isInStages(currentNovel.stage, STAGES_THAT_CAN_REGENERATE_BLUEPRINT)) {
      return NextResponse.json(
        { error: 'Blueprint can only be regenerated before writing begins.' },
        { status: 409 },
      );
    }

    const chapters = await getChaptersLite(id);
    if (fromChapter === null && chapters.length > 0) {
      return NextResponse.json(
        { error: 'Cannot regenerate the full blueprint after chapters exist. Use ?fromChapter=N to rewrite from a specific chapter.' },
        { status: 409 },
      );
    }

    let existingBlueprint = null;
    let keepChapters: { chapterNumber: number; title: string; summary: string }[] = [];
    if (fromChapter !== null) {
      existingBlueprint = await getNovelBlueprint(id);
      if (!existingBlueprint) {
        return NextResponse.json(
          { error: 'No existing blueprint to rewrite from. Generate one first.' },
          { status: 409 },
        );
      }
      keepChapters = existingBlueprint.chapters
        .filter(c => c.chapterNumber < fromChapter)
        .map(c => ({ chapterNumber: c.chapterNumber, title: c.title, summary: c.summary }));
      if (keepChapters.length === 0) {
        return NextResponse.json(
          { error: `Cannot rewrite from chapter ${fromChapter}: no earlier chapters exist in the blueprint.` },
          { status: 400 },
        );
      }
    }

    const locale = normalizeLocale(request.headers.get('x-locale'));
    let usage;
    try {
      usage = await createAIUsageSession(request, { userId: user.id, operation: 'outline' });
    } catch (error) {
      const r = aiUsageErrorResponse(error);
      if (r) return r;
      throw error;
    }

    // W2-C: blueprint regen runs the `outline` op so recall biases toward the
    // structural-planning role + volume summaries.
    let promptResult: NonNullable<Awaited<ReturnType<typeof buildNovelSystemPromptFromDB>>>;
    try {
      const resolvedPrompt = await buildNovelSystemPromptFromDB(
        id,
        locale,
        currentNovel,
        {
          op: 'outline',
          modelCtxTokens: usage.runtimeModel.contextWindow,
          embeddingHint: resolveEmbeddingEndpointFromRequest(request),
        },
      );
      if (!resolvedPrompt) {
        await usage.fail();
        return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
      }
      promptResult = resolvedPrompt;
    } catch (error) {
      await usage.fail();
      throw error;
    }
    const language = detectLanguage(buildNovelLanguageSignals(currentNovel, []));

    let systemPrompt = promptResult.systemPrompt;
    if (fromChapter !== null) {
      const keepList = keepChapters
        .map(c => `- Chapter ${c.chapterNumber}: ${c.title}\n  ${c.summary}`)
        .join('\n');
      systemPrompt += `\n\n--- Locked earlier chapters (do not modify) ---\n${keepList}\n\nYour task: re-plan chapters ${fromChapter} through the end. Keep the same total chapter count as before (${existingBlueprint!.chapters.length}). The earlier chapters above are immutable — your plan must continue smoothly from chapter ${fromChapter - 1}.`;
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
      usage.addPromptText(systemPrompt);
      const result = await generateBookBlueprint({
        model: usage.model,
        novelContext: currentNovel,
        language,
        systemPrompt,
        signal: request.signal,
      });
      usage.addPartialOutput(JSON.stringify(result.chapters));
      if (request.signal.aborted) {
        await cancelUsageOnce();
        return new Response(null, { status: 499 });
      }

      // Splice kept + newly-generated tail. If the AI ignored the lock and
      // returned chapters numbered from 1, fail loud — silently renumbering
      // would attach content from chapter 1 onto chapter N, corrupting the
      // plan. Caller can retry with a sharper prompt.
      let finalChapters = result.chapters;
      if (fromChapter !== null) {
        const tail = result.chapters
          .filter(c => c.chapterNumber >= fromChapter)
          .sort((a, b) => a.chapterNumber - b.chapterNumber);
        if (tail.length === 0) {
          await failUsageOnce();
          return NextResponse.json(
            { error: `The model ignored the locked-chapters constraint and returned chapters starting from ${result.chapters[0]?.chapterNumber ?? '?'}. Please retry; the locked chapters were not modified.` },
            { status: 502 },
          );
        }
        const expectedTotal = existingBlueprint!.chapters.length;
        const expectedTailCount = expectedTotal - fromChapter + 1;
        const tailNumbers = tail.map(c => c.chapterNumber);
        const hasExpectedNumbering = tailNumbers.length === expectedTailCount
          && tailNumbers.every((chapterNumber, index) => chapterNumber === fromChapter + index);
        if (!hasExpectedNumbering) {
          await failUsageOnce();
          return NextResponse.json(
            { error: `The model returned ${tail.length} tail chapters, but the existing blueprint requires exactly ${expectedTailCount} chapters numbered ${fromChapter}-${expectedTotal}. Locked chapters were not modified.` },
            { status: 502 },
          );
        }
        finalChapters = [
          ...keepChapters.map(k => existingBlueprint!.chapters.find(c => c.chapterNumber === k.chapterNumber)!),
          ...tail,
        ];
        if (finalChapters.length !== expectedTotal) {
          await failUsageOnce();
          return NextResponse.json(
            { error: `Partial regeneration must preserve the original ${expectedTotal}-chapter outline.` },
            { status: 502 },
          );
        }
      }

      const targetWordsPerChapter = getTargetWordsPerChapter(currentNovel.targetWords, finalChapters.length);
      const blueprint = {
        chapters: finalChapters,
        targetWordsPerChapter,
        generatedAt: new Date().toISOString(),
        modelId: usage.runtimeModel.id,
      };
      if (request.signal.aborted) {
        await cancelUsageOnce();
        return new Response(null, { status: 499 });
      }
      const stillOwned = await renewWritingLock(id, lock.token, LOCK_TTL_SEC);
      if (!stillOwned) {
        await failUsageOnce();
        return NextResponse.json(
          { error: 'Blueprint regeneration lock was lost before commit. Please retry.' },
          { status: 409 },
        );
      }
      if (fromChapter !== null) {
        await setNovelBlueprintAfterDeletingChaptersFrom(id, blueprint, fromChapter);
      } else {
        // setNovelBlueprint performs the outline delete+insert inside one DB
        // transaction, so callers must not clear the current plan first.
        await setNovelBlueprint(id, blueprint);
      }
      await usage.recordUsage(result.usage);
      usageSettled = true;

      return NextResponse.json({ blueprint });
    } catch (err) {
      if (request.signal.aborted) await cancelUsageOnce();
      else await failUsageOnce();
      throw err;
    }
  } catch (err) {
    console.error('Blueprint regenerate error:', err);
    return NextResponse.json({ error: sanitizeError(err, 'Failed to regenerate blueprint') }, { status: 500 });
  } finally {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
  }
}
