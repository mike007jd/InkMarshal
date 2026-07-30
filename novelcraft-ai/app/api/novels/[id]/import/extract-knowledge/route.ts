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
//   - a newer import starts     → generation fence stops all stale writes.
//
// The kbExtraction state is read back by the wizard's progress UI.

import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { aiUsageErrorResponse, createAIUsageSession } from '@/lib/ai-usage';
import { requestLocale } from '@/lib/request-locale';
import {
  claimNovelKbExtraction,
  getChapters,
  renewNovelKbExtractionClaim,
  updateNovelKbExtractionState,
} from '@/lib/db';
import { extractKnowledgeFromManuscript } from '@/lib/import/extract-knowledge';
import type { ImportMeta } from '@/lib/db-types';
import { isUuid } from '@/lib/utils';

export const runtime = 'nodejs';
export const maxDuration = 300;

const KB_EXTRACTION_LEASE_MS = 90_000;
const KB_EXTRACTION_HEARTBEAT_MS = 30_000;
const KB_EXTRACTION_DEADLINE_MS = 280_000;

function setKbState(
  novelId: string,
  kbExtractionId: string,
  kbExtractionAttemptId: string,
  state: Extract<ImportMeta['kbExtraction'], 'done' | 'failed'>,
): boolean {
  return updateNovelKbExtractionState(
    novelId,
    kbExtractionId,
    kbExtractionAttemptId,
    state,
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: novelId } = await params;
  const body = await req.json().catch(() => null) as {
    kbExtractionId?: unknown;
  } | null;
  if (!body || !isUuid(body.kbExtractionId)) {
    return NextResponse.json({ error: 'Invalid extraction generation.' }, { status: 400 });
  }
  const kbExtractionId = body.kbExtractionId;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const claim = claimNovelKbExtraction(
    novelId,
    kbExtractionId,
    KB_EXTRACTION_LEASE_MS,
  );
  if (claim.status !== 'claimed') {
    const outcome = claim.status === 'completed'
      ? 'already_done'
      : claim.status;
    return NextResponse.json({ outcome, created: 0 });
  }
  const kbExtractionAttemptId = claim.attemptId;

  const leaseController = new AbortController();
  let claimLost = false;
  const heartbeat = setInterval(() => {
    try {
      if (!renewNovelKbExtractionClaim(
        novelId,
        kbExtractionId,
        kbExtractionAttemptId,
        KB_EXTRACTION_LEASE_MS,
      )) {
        claimLost = true;
        leaseController.abort();
      }
    } catch {
      claimLost = true;
      leaseController.abort();
    }
  }, KB_EXTRACTION_HEARTBEAT_MS);
  const deadline = setTimeout(
    () => {
      clearInterval(heartbeat);
      leaseController.abort();
    },
    KB_EXTRACTION_DEADLINE_MS,
  );

  try {
    const chapters = await getChapters(novelId);
    if (chapters.length === 0) {
      const current = setKbState(
        novelId,
        kbExtractionId,
        kbExtractionAttemptId,
        'failed',
      );
      return NextResponse.json({
        outcome: current ? 'failed' : 'superseded',
        created: 0,
      });
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
        const current = setKbState(
          novelId,
          kbExtractionId,
          kbExtractionAttemptId,
          'failed',
        );
        if (!current) {
          return NextResponse.json({ outcome: 'superseded', created: 0 });
        }
        return NextResponse.json(
          { outcome: 'failed', created: 0, _modelUnavailable: true },
          { status: 200 },
        );
      }
      throw error;
    }

    const extractionSignal = AbortSignal.any([req.signal, leaseController.signal]);
    let resolveAbort!: () => void;
    const aborted = new Promise<{
      outcome: 'cancelled';
      created: 0;
    }>(resolve => {
      resolveAbort = () => resolve({ outcome: 'cancelled', created: 0 });
      if (extractionSignal.aborted) resolveAbort();
      else extractionSignal.addEventListener('abort', resolveAbort, { once: true });
    });
    const extraction = extractKnowledgeFromManuscript({
      novelId,
      kbExtractionId,
      kbExtractionAttemptId,
      completedSlots: claim.completedSlots,
      chapters: chapters.map(c => ({ title: c.title, content: c.content })),
      model: aiUsage.model,
      locale: requestLocale(req.headers),
      signal: extractionSignal,
    });
    const result = await Promise.race([extraction, aborted]);
    extractionSignal.removeEventListener('abort', resolveAbort);

    if (result.outcome === 'cancelled') {
      // The imported manuscript remains intact; only the optional enrichment is
      // marked failed so the user can retry it later.
      const current = setKbState(
        novelId,
        kbExtractionId,
        kbExtractionAttemptId,
        'failed',
      );
      await aiUsage.cancel();
      if (claimLost || !current) {
        return NextResponse.json({
          outcome: 'superseded',
          created: result.created,
        });
      }
      return new Response(null, { status: 499 });
    }

    await aiUsage.recordUsage(undefined);
    if (result.outcome === 'superseded') {
      return NextResponse.json(result);
    }
    const current = setKbState(
      novelId,
      kbExtractionId,
      kbExtractionAttemptId,
      result.outcome === 'done' ? 'done' : 'failed',
    );
    if (!current) {
      return NextResponse.json({
        outcome: 'superseded',
        created: result.created,
      });
    }
    return NextResponse.json({ outcome: result.outcome, created: result.created });
  } catch (error) {
    try {
      setKbState(
        novelId,
        kbExtractionId,
        kbExtractionAttemptId,
        'failed',
      );
    } catch {
      // Preserve the original route failure; an unavailable DB cannot be
      // settled synchronously and the bounded lease remains the fallback.
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
  }
}
