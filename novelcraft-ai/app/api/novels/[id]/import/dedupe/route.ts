// POST /api/novels/[id]/import/dedupe
//
// Recompute the merge dedupe report for compact chapter refs against a target
// novel's current chapters. Full prose is reconstructed server-side from the
// opaque import session — the client never re-uploads chapter bodies.

import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { safeParseJsonObject } from '@/lib/utils';
import { dedupeImportSession } from '@/lib/import/session-confirm';
import type { ImportChapterPart } from '@/lib/import/types';
import { MAX_IMPORT_CHAPTERS, MAX_IMPORT_PARTS } from '@/lib/import/limits';

export const runtime = 'nodejs';

interface DedupeBody {
  sessionToken?: unknown;
  chapters?: {
    id?: unknown;
    title?: unknown;
    parts?: unknown;
  }[];
}

function parseParts(raw: unknown): ImportChapterPart[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parts: ImportChapterPart[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    if (typeof row.segmentId !== 'string' || !row.segmentId) return null;
    if (!Number.isInteger(row.fromParagraph) || !Number.isInteger(row.toParagraph)) return null;
    parts.push({
      segmentId: row.segmentId,
      fromParagraph: row.fromParagraph as number,
      toParagraph: row.toParagraph as number,
    });
  }
  return parts;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: novelId } = await params;

  const ownerCheck = await requireNovelOwner(novelId);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const parsed = await safeParseJsonObject<DedupeBody>(req);
  if (parsed.error) return parsed.error as NextResponse;

  const sessionToken = typeof parsed.data.sessionToken === 'string'
    ? parsed.data.sessionToken
    : '';
  if (!sessionToken) {
    return NextResponse.json({ error: 'Import session token is required' }, { status: 400 });
  }

  const rawChapters = Array.isArray(parsed.data.chapters) ? parsed.data.chapters : [];
  if (rawChapters.length === 0 || rawChapters.length > MAX_IMPORT_CHAPTERS) {
    return NextResponse.json({ error: 'Invalid chapter set' }, { status: 400 });
  }

  const chapters: { title: string; parts: ImportChapterPart[] }[] = [];
  const candidateIds: string[] = [];
  let partCount = 0;
  for (const [index, c] of rawChapters.entries()) {
    const parts = parseParts(c?.parts);
    if (!parts) {
      return NextResponse.json({ error: 'Invalid chapter parts' }, { status: 400 });
    }
    partCount += parts.length;
    if (partCount > MAX_IMPORT_PARTS) {
      return NextResponse.json({ error: 'Too many chapter parts' }, { status: 400 });
    }
    const id = typeof c?.id === 'string' && c.id ? c.id : `preview-${index + 1}`;
    candidateIds.push(id);
    chapters.push({
      title: typeof c?.title === 'string' ? c.title : '',
      parts,
    });
  }

  try {
    const report = await dedupeImportSession({
      sessionToken,
      targetNovelId: novelId,
      chapters,
      candidateIds,
    });
    return NextResponse.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Dedupe failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
