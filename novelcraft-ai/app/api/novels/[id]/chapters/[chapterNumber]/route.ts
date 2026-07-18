import { NextResponse } from 'next/server';
import { acquireWritingLock, getChapter, releaseWritingLock, updateChapterContent } from '@/lib/db';
import { requireNovelOwner } from '@/lib/local-auth';
import { parseNonNegativeIntegerParam, parsePositiveIntegerParam } from '@/lib/route-params';
import { safeParseJsonObject } from '@/lib/utils';

export const MAX_CHAPTER_PATCH_CONTENT_CHARS = 500_000;
const LOCK_TTL_SEC = 60;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; chapterNumber: string }> },
) {
  const { id, chapterNumber: chapterNumStr } = await params;
  const chapterNumber = parsePositiveIntegerParam(chapterNumStr);
  if (chapterNumber === null) {
    return NextResponse.json({ error: 'Invalid chapter number' }, { status: 400 });
  }

  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const parsed = await safeParseJsonObject<{ content?: unknown; version?: unknown }>(request);
  if (parsed.error) return parsed.error as NextResponse;
  const { content, version } = parsed.data;

  if (typeof content !== 'string') {
    return NextResponse.json({ error: 'content is required' }, { status: 400 });
  }
  if (content.length > MAX_CHAPTER_PATCH_CONTENT_CHARS) {
    return NextResponse.json({ error: 'content too large' }, { status: 400 });
  }
  const expectedVersion = parseNonNegativeIntegerParam(version);
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

    const result = await updateChapterContent(id, chapterNumber, content, expectedVersion);

    if (result.conflict) {
      return NextResponse.json(
        { error: '此章节已被其他标签页修改，请刷新后重试', code: 'VERSION_CONFLICT' },
        { status: 409 },
      );
    }

    return NextResponse.json({ success: true, version: result.version });
  } finally {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
  }
}
