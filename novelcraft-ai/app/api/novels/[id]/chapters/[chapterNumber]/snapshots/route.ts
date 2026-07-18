import { NextResponse } from 'next/server';
import {
  acquireWritingLock,
  createChapterSnapshot,
  listChapterSnapshots,
  getChapter,
  releaseWritingLock,
} from '@/lib/db';
import { requireNovelOwner } from '@/lib/local-auth';
import { parsePositiveIntegerParam } from '@/lib/route-params';
import { safeParseJsonObject } from '@/lib/utils';

const LOCK_TTL_SEC = 60;

/**
 * GET — list snapshots for a chapter. When the chapter has no explicit
 * snapshots but does have an `originalContent`, the response surfaces a
 * single synthetic entry with `id = "__original__"` so clients can offer
 * "Restore first draft" without a separate code path.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; chapterNumber: string }> },
) {
  const { id, chapterNumber: chapterNumStr } = await params;
  const chapterNumber = parsePositiveIntegerParam(chapterNumStr);
  if (chapterNumber === null) {
    return NextResponse.json({ error: 'Invalid chapter number' }, { status: 400 });
  }

  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const chapter = await getChapter(id, chapterNumber);
  if (!chapter) {
    return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
  }

  const snapshots = await listChapterSnapshots(id, chapterNumber);
  return NextResponse.json({ snapshots });
}

/**
 * POST — capture the chapter's current content as a new snapshot. Returns
 * the freshly created snapshot. Label is optional, trimmed and capped to
 * 80 chars server-side.
 */
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

  const parsed = await safeParseJsonObject<{ label?: unknown }>(request);
  if (parsed.error) return parsed.error as NextResponse;
  const labelRaw = parsed.data.label;
  const label = typeof labelRaw === 'string' ? labelRaw : undefined;

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

    const snapshot = await createChapterSnapshot(id, chapterNumber, label);
    if (!snapshot) {
      return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
    }
    return NextResponse.json({ snapshot });
  } finally {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
  }
}
