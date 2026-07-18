// POST /api/knowledge/style-extract
//
// Wave 4 commit F. Given a prose sample, return a compact structured
// `StyleNotes` JSON. Designed for the KnowledgeEntryForm's
// "Generate style notes from sample" button — the form takes the response
// and pre-fills `data.styleNotes` so the user can save without manually
// describing their voice.
//
// Uses the user's bound `recall` model (operation: 'summarize' resolves to
// the recall role per OPERATION_ROLE), which is the lightest available
// model. If model resolution fails the route still returns 200 with an
// empty profile — the form falls back to "user fills in manually" rather
// than blocking on auto-extract.

import { NextResponse } from 'next/server';
import { requireLocalUser } from '@/lib/local-auth';
import { aiUsageErrorResponse, createAIUsageSession } from '@/lib/ai-usage';
import { safeParseJsonObject } from '@/lib/utils';
import { requestLocale } from '@/lib/request-locale';
import {
  EMPTY_STYLE_NOTES,
  extractStyleNotesResult,
} from '@/lib/ai/style-extractor';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface ExtractPayload {
  sampleText: string;
}

export async function POST(req: Request) {
  const { user } = await requireLocalUser();

  const parsed = await safeParseJsonObject<Partial<ExtractPayload>>(req);
  if (parsed.error) return parsed.error;
  const sampleText = parsed.data.sampleText;

  if (typeof sampleText !== 'string') {
    return NextResponse.json({ error: 'sampleText required' }, { status: 400 });
  }
  if (sampleText.length > 20_000) {
    return NextResponse.json({ error: 'sampleText too large (max 20000 chars)' }, { status: 400 });
  }

  // Operation: 'summarize' resolves to the recall role. If the user has not
  // bound a model, degrade to the empty-notes shape rather than blocking the
  // form; no server-owned env/gateway model is consulted.
  let aiUsage;
  try {
    aiUsage = await createAIUsageSession(req, { userId: user.id, operation: 'summarize' });
  } catch (error) {
    const response = aiUsageErrorResponse(error);
    if (response) {
      // Caller can recover by hand-filling — return the empty shape so the
      // form treats it as "extraction succeeded but model was unavailable"
      // and shows the manual-fill hint via the toast.
      return NextResponse.json({ ...EMPTY_STYLE_NOTES, _modelUnavailable: true }, { status: 200 });
    }
    throw error;
  }

  aiUsage.addPromptText(sampleText.slice(0, 4_000));
  let result: Awaited<ReturnType<typeof extractStyleNotesResult>>;
  try {
    result = await extractStyleNotesResult({
      sampleText,
      model: aiUsage.model,
      locale: requestLocale(req.headers),
      signal: req.signal,
    });
  } catch (err) {
    // extractStyleNotesResult re-throws on user-initiated cancel rather than
    // returning an empty-stub. Settle usage and return 499 here so the abort
    // doesn't escape as an unhandled 500.
    if (req.signal.aborted) {
      await aiUsage.cancel();
      return new Response(null, { status: 499 });
    }
    await aiUsage.fail();
    throw err;
  }
  if (req.signal.aborted) {
    await aiUsage.cancel();
    return new Response(null, { status: 499 });
  }
  if (!result.ok) {
    await aiUsage.fail();
    return NextResponse.json(result.notes);
  }
  // Best-effort settle — the tolerant extractor hides usage on fallback, so
  // record an empty bag.
  await aiUsage.recordUsage(undefined);
  return NextResponse.json(result.notes);
}
