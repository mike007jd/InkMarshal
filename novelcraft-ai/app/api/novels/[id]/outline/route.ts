import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { getOutlineWithChapterStatus } from '@/lib/db';
import { parseKnowledgeEntry } from '@/lib/knowledge';
import type { KnowledgeEntry } from '@/lib/types/knowledge';

/**
 * W2-D: outline list joined against the `chapters` table so the OutlineBoard
 * can render a "已写 / 未写" badge + actual word count without an extra
 * round-trip. Returns the parsed `KnowledgeEntry` shape augmented with
 * `hasChapter` + `chapterWordCount`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const rows = await getOutlineWithChapterStatus(id);
  const entries = rows.map(r => {
    const parsed = parseKnowledgeEntry(r as unknown as Record<string, unknown>) as KnowledgeEntry & {
      hasChapter?: boolean;
      chapterWordCount?: number;
    };
    parsed.hasChapter = r.hasChapter;
    parsed.chapterWordCount = r.chapterWordCount;
    return parsed;
  });
  return NextResponse.json(entries);
}
