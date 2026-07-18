import { describe, expect, it } from 'vitest';

import { buildOutlineDeckRows } from '@/components/knowledge/KnowledgePanel';
import type { OutlineEntry, OutlineLevel } from '@/lib/types/knowledge';

function outline(
  id: string,
  level: OutlineLevel,
  parentId: string,
  chapterNumber: number,
  sortOrder = chapterNumber,
): OutlineEntry {
  return {
    id,
    novelId: 'novel',
    type: 'outline',
    title: id,
    summary: '',
    sortOrder,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    data: {
      chapterId: '',
      chapterNumber,
      synopsis: '',
      keyEvents: [],
      characters: [],
      pov: '',
      status: 'planned',
      wordCountTarget: 0,
      notes: '',
      level,
      parentId,
      sceneMeta: { pov: '', time: '', location: '', conflict: '', outcome: '' },
      plotlineTags: [],
      characterArcTags: [],
      customMeta: {},
    },
  };
}

describe('buildOutlineDeckRows', () => {
  it('orders siblings and keeps scene/beat nodes under their real parentId chain', () => {
    const rows = buildOutlineDeckRows([
      outline('chapter-2', 'chapter', 'volume', 2),
      outline('beat', 'beat', 'scene', 1),
      outline('volume', 'volume', '', 1),
      outline('scene', 'scene', 'chapter-1', 1),
      outline('chapter-1', 'chapter', 'volume', 1),
      outline('orphan', 'scene', 'missing-parent', 3),
    ]);

    expect(rows.map(row => [row.entry.id, row.depth])).toEqual([
      ['volume', 0],
      ['chapter-1', 1],
      ['scene', 2],
      ['beat', 3],
      ['chapter-2', 1],
      ['orphan', 0],
    ]);
  });
});
