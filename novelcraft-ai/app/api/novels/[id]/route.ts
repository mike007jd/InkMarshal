import { NextResponse } from 'next/server';
import { acquireWritingLock, releaseWritingLock, trashNovel, updateNovel } from '@/lib/db';
import { requireNovelOwner } from '@/lib/local-auth';
import { safeParseJson, sanitizeError } from '@/lib/utils';
import { projectBlueprintFromOutline } from '@/lib/ai/blueprint-projection';
import { updateNovelRequestSchema, type UpdateNovelRequest } from '@/lib/types/novel';
import type { Novel } from '@/lib/db-types';
import { getNovelSeriesId, reprojectSharedEntriesForSeries } from '@/lib/db/queries-series';
import { getLatestWritingJob } from '@/lib/db/queries-writing-jobs';

const LOCK_TTL_SEC = 60;

function hasNovelPatchChange(body: UpdateNovelRequest, novel: Pick<Novel, 'title' | 'genre' | 'targetWords'>): boolean {
  return (
    (Object.prototype.hasOwnProperty.call(body, 'title') && body.title !== novel.title) ||
    (Object.prototype.hasOwnProperty.call(body, 'genre') && body.genre !== novel.genre) ||
    (Object.prototype.hasOwnProperty.call(body, 'targetWords') && body.targetWords !== novel.targetWords)
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  // W2-D: `novels.blueprint` column was dropped — but the API contract still
  // includes a `blueprint` field so the manuscript-session resume gate and
  // the streaming `blueprint` event keep working. Project it on demand from
  // outline knowledge entries (cheap: a single index/canonical table scan).
  const blueprint = await projectBlueprintFromOutline(id);
  const writingJob = getLatestWritingJob(id);
  return NextResponse.json({ ...ownerCheck.novel, blueprint, writingJob });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  try {
    const parsed = await safeParseJson<unknown>(request);
    if (parsed.error) return parsed.error;
    const body = updateNovelRequestSchema.parse(parsed.data);
    if (!hasNovelPatchChange(body, ownerCheck.novel)) {
      return NextResponse.json(ownerCheck.novel);
    }
    // External API: only allow safe fields (title, genre, targetWords).
    const updatedNovel = await updateNovel(id, body, false);
    if (!updatedNovel) {
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }
    return NextResponse.json(updatedNovel);
  } catch (error) {
    console.error('updateNovel failed:', error);
    return NextResponse.json({ error: sanitizeError(error, 'Failed to update novel') }, { status: 400 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const lock = await acquireWritingLock(id, LOCK_TTL_SEC);
  if (!lock) {
    return NextResponse.json(
      { error: 'Another writing session is already in progress for this novel.' },
      { status: 409 },
    );
  }

  try {
    const seriesId = await getNovelSeriesId(id);
    const trashed = await trashNovel(id, ownerCheck.user.id);
    if (!trashed) {
      return NextResponse.json({ error: 'Failed to move novel to Trash' }, { status: 500 });
    }
    if (seriesId) await reprojectSharedEntriesForSeries(seriesId);
    return NextResponse.json({ ok: true, trashed: true });
  } finally {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
  }
}
