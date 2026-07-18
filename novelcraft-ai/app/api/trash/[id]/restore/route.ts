import { NextResponse } from 'next/server';

import { restoreTrashedNovel } from '@/lib/db';
import { requireTrashedNovelOwner } from '@/lib/local-auth';
import { getNovelSeriesId, reprojectSharedEntriesForSeries } from '@/lib/db/queries-series';

export const runtime = 'nodejs';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireTrashedNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const restored = await restoreTrashedNovel(id, ownerCheck.user.id);
  if (!restored) return NextResponse.json({ error: 'Restore failed' }, { status: 409 });
  const seriesId = await getNovelSeriesId(id);
  if (seriesId) await reprojectSharedEntriesForSeries(seriesId);
  return NextResponse.json(restored);
}
