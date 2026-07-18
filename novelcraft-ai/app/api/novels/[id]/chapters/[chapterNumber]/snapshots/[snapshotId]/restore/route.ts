import { NextResponse } from 'next/server';
import { acquireWritingLock, getChapter, releaseWritingLock, restoreChapterSnapshot } from '@/lib/db';
import { requireNovelOwner } from '@/lib/local-auth';
import { parseNonNegativeIntegerParam, parsePositiveIntegerParam } from '@/lib/route-params';
import { countWords, safeParseJsonObject } from '@/lib/utils';

const LOCK_TTL_SEC = 60;

/**
 * POST — restore the chapter's content to a snapshot. The route participates
 * in optimistic locking via `chapter.version`; if the chapter has been
 * modified since the client last loaded it the call returns 409, mirroring
 * the PATCH `/chapters/[n]` contract.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; chapterNumber: string; snapshotId: string }> },
) {
  const { id, chapterNumber: chapterNumStr, snapshotId } = await params;
  const chapterNumber = parsePositiveIntegerParam(chapterNumStr);
  if (chapterNumber === null) {
    return NextResponse.json({ error: 'Invalid chapter number' }, { status: 400 });
  }

  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const parsed = await safeParseJsonObject<{ version?: unknown }>(request);
  if (parsed.error) return parsed.error as NextResponse;
  const expectedVersion = parseNonNegativeIntegerParam(parsed.data.version);
  if (expectedVersion === null) {
    return NextResponse.json({ error: 'version must be a non-negative integer' }, { status: 400 });
  }

  const lock = await acquireWritingLock(id, LOCK_TTL_SEC);
  if (!lock) {
    return NextResponse.json(
      { error: 'Another writing session is already in progress for this novel.' },
      { status: 409 },
    );
  }

  try {
    const chapter = await getChapter(id, chapterNumber);
    if (!chapter) {
      return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
    }

    const result = await restoreChapterSnapshot(id, chapterNumber, snapshotId, expectedVersion);
    if (!result) {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    }
    if (result.conflict) {
      return NextResponse.json(
        { error: 'This chapter was modified elsewhere. Reload and try again.', code: 'VERSION_CONFLICT' },
        { status: 409 },
      );
    }

    return NextResponse.json({
      success: true,
      content: result.content,
      wordCount: countWords(result.content),
      version: result.version,
    });
  } finally {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
  }
}
