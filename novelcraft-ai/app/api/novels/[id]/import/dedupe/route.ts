// POST /api/novels/[id]/import/dedupe
//
// W2-1. Recompute the merge dedupe report for a set of import candidates against
// a target novel's current chapters, WITHOUT re-uploading the source file. The
// wizard calls this when the user switches the merge target after parsing.
//
// Pure read — never writes. Runs the deterministic `dedupeCandidates` over the
// target's existing chapters; the candidates' content is supplied by the client
// (already in memory from the parse step).

import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { safeParseJsonObject } from '@/lib/utils';
import { getChapters } from '@/lib/db';
import { dedupeCandidates } from '@/lib/import/dedupe';
import type { ChapterCandidate } from '@/lib/import/types';

export const runtime = 'nodejs';

interface DedupeBody {
  candidates?: { id?: unknown; title?: unknown; content?: unknown }[];
}

const MAX_CANDIDATES = 5_000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: novelId } = await params;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const parsed = await safeParseJsonObject<DedupeBody>(req);
  if (parsed.error) return parsed.error as NextResponse;

  const rawCandidates = Array.isArray(parsed.data.candidates) ? parsed.data.candidates : [];
  if (rawCandidates.length > MAX_CANDIDATES) {
    return NextResponse.json({ error: 'Too many candidates' }, { status: 400 });
  }

  // Normalize into the minimal ChapterCandidate shape dedupe needs. Fields the
  // dedupe ignores (volumeTitle, wordCount, etc.) are stubbed.
  const candidates: ChapterCandidate[] = rawCandidates.map((c, index) => ({
    id: typeof c.id === 'string' ? c.id : `cand-${index + 1}`,
    chapterNumber: index + 1,
    title: typeof c.title === 'string' ? c.title : '',
    volumeTitle: null,
    content: typeof c.content === 'string' ? c.content : '',
    wordCount: 0,
    inferred: false,
  }));

  const existing = await getChapters(novelId);
  const report = dedupeCandidates(
    candidates,
    existing.map(ch => ({ chapterNumber: ch.chapterNumber, title: ch.title, content: ch.content })),
  );

  return NextResponse.json(report);
}
