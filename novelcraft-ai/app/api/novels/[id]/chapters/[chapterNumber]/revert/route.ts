import { NextResponse } from 'next/server';
import { acquireWritingLock, getChapter, releaseWritingLock, revertChapterToOriginalContent } from '@/lib/db';
import { requireNovelOwner } from '@/lib/local-auth';
import { parseNonNegativeIntegerParam, parsePositiveIntegerParam } from '@/lib/route-params';
import { countWords, safeParseJsonObject } from '@/lib/utils';

const LOCK_TTL_SEC = 60;

export async function POST(
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

    if (chapter.originalContent === null) {
      return NextResponse.json({ error: 'No original version to revert to' }, { status: 409 });
    }

    const result = await revertChapterToOriginalContent(id, chapterNumber, expectedVersion);
    if (!result) {
      return NextResponse.json({ error: 'No original version to revert to' }, { status: 409 });
    }
    if (result.conflict) {
      return NextResponse.json(
        { error: '此章节已被其他标签页修改，请刷新后重试', code: 'VERSION_CONFLICT' },
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
