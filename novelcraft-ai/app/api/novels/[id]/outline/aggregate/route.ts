import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { getKnowledgeEntries } from '@/lib/db';
import { parseKnowledgeEntry } from '@/lib/knowledge';
import { outlineDataSchema, type OutlineData } from '@/lib/types/knowledge';
import {
  aggregateScenes,
  collectAggregateValues,
  isAggregateBy,
  type AggregateNode,
} from '@/lib/outline/aggregate';

/**
 * W3-1 aggregate view. `GET ?by=character|location|plotline[&value=...]`.
 *   - With `value`: returns every scene matching that value on the axis.
 *   - Without `value`: returns the distinct facet values (+ scene counts) so the
 *     UI can render a picker.
 * Scene-level rows only (the aggregator filters internally). Reuses the existing
 * outline-row loader + zod parser so the new `sceneMeta`/tag fields hydrate with
 * their defaults on current rows.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const url = new URL(request.url);
  const by = url.searchParams.get('by');
  const value = url.searchParams.get('value');

  if (!isAggregateBy(by)) {
    return NextResponse.json(
      { error: 'Invalid "by" — expected character | location | plotline' },
      { status: 400 },
    );
  }

  const rows = await getKnowledgeEntries(id, { type: 'outline' });
  const nodes: AggregateNode[] = rows.map(row => {
    const parsed = parseKnowledgeEntry(row as unknown as Record<string, unknown>);
    // Hydrate through the schema so current rows get sceneMeta/tag defaults.
    const data: OutlineData = outlineDataSchema.parse(parsed.data ?? {});
    return {
      id: parsed.id,
      title: parsed.title,
      level: data.level,
      parentId: data.parentId,
      synopsis: data.synopsis,
      characters: data.characters,
      plotlineTags: data.plotlineTags,
      characterArcTags: data.characterArcTags,
      sceneMeta: data.sceneMeta,
      chapterNumber: data.chapterNumber,
    };
  });

  if (value !== null && value.trim().length > 0) {
    return NextResponse.json({
      by,
      value,
      scenes: aggregateScenes(nodes, by, value),
    });
  }

  return NextResponse.json({
    by,
    values: collectAggregateValues(nodes, by),
  });
}
