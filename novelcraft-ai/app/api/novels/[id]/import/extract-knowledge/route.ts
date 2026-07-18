// POST /api/novels/[id]/import/extract-knowledge
//
// W2-1. After a manuscript import, optionally mine the freshly-written chapters
// for knowledge-base entries (characters / world / timeline + one style
// reference). Uses the user's bound `recall` model (operation 'summarize'). The
// import itself already succeeded — this is best-effort enrichment, so:
//
//   - no model bound          → write importMeta.kbExtraction='failed', return 200.
//   - extraction fails/aborts  → same; the import is never rolled back.
//   - extraction succeeds      → write importMeta.kbExtraction='done'.
//
// The kbExtraction state is read back by the wizard's progress UI.

import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { aiUsageErrorResponse, createAIUsageSession } from '@/lib/ai-usage';
import { requestLocale } from '@/lib/request-locale';
import { getChapters, updateNovel } from '@/lib/db';
import { extractKnowledgeFromManuscript } from '@/lib/import/extract-knowledge';
import type { ImportMeta, NovelSettings } from '@/lib/db-types';

export const runtime = 'nodejs';
export const maxDuration = 300;

async function setKbState(
  novelId: string,
  settings: NovelSettings | null | undefined,
  state: ImportMeta['kbExtraction'],
): Promise<void> {
  if (!settings?.importMeta) return; // no import metadata to annotate.
  await updateNovel(novelId, {
    settings: { ...settings, importMeta: { ...settings.importMeta, kbExtraction: state } },
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: novelId } = await params;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { novel } = ownerCheck;

  const chapters = await getChapters(novelId);
  if (chapters.length === 0) {
    return NextResponse.json({ outcome: 'failed', created: 0 }, { status: 200 });
  }

  // Bind a recall-class model. If none is available, mark failed and return —
  // the user can re-run later from the KB panel.
  let aiUsage;
  try {
    aiUsage = await createAIUsageSession(req, {
      userId: ownerCheck.user.id,
      operation: 'summarize',
    });
  } catch (error) {
    const response = aiUsageErrorResponse(error);
    if (response) {
      await setKbState(novelId, novel.settings, 'failed');
      return NextResponse.json(
        { outcome: 'failed', created: 0, _modelUnavailable: true },
        { status: 200 },
      );
    }
    throw error;
  }

  const result = await extractKnowledgeFromManuscript({
    novelId,
    chapters: chapters.map(c => ({ title: c.title, content: c.content })),
    model: aiUsage.model,
    locale: requestLocale(req.headers),
    signal: req.signal,
  });

  if (result.outcome === 'cancelled') {
    await aiUsage.fail();
    // Leave kbExtraction at its prior 'pending' so the user can resume; treat a
    // cancel as a soft failure for the meta state.
    await setKbState(novelId, novel.settings, 'failed');
    return new Response(null, { status: 499 });
  }

  await aiUsage.recordUsage(undefined);
  await setKbState(novelId, novel.settings, result.outcome === 'done' ? 'done' : 'failed');
  return NextResponse.json({ outcome: result.outcome, created: result.created });
}
