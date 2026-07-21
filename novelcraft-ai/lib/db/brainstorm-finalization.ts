import type { Novel } from '@/lib/db-types';
import { getDb } from '@/lib/db/connection';
import { applyNovelUpdate } from '@/lib/db/queries-novel';
import type { KnowledgeEntryRow } from '@/lib/db/queries-knowledge';
import { nowIso } from '@/lib/utils';

const EDITABLE_STAGES = new Set(['discovery_interview', 'ready_for_greenlight']);

export type BrainstormFinalizationEntry = {
  type: 'character' | 'world' | 'outline';
  title: string;
  summary: string;
  data: Record<string, unknown>;
  tags: string[];
};

type BrainstormEntryMutation = {
  action: 'created' | 'updated' | 'unchanged';
  before: KnowledgeEntryRow | null;
  after: KnowledgeEntryRow;
};

export type FinalizeBrainstormResult =
  | {
      ok: true;
      beforeNovel: Novel;
      novel: Novel;
      mutations: BrainstormEntryMutation[];
      coverage: Record<BrainstormFinalizationEntry['type'], number>;
    }
  | { ok: false; reason: 'not_found' | 'not_editable' | 'incomplete' };

function normalizedTitle(value: string): string {
  return value.trim().toLowerCase();
}
function sameEntry(
  row: KnowledgeEntryRow,
  entry: BrainstormFinalizationEntry,
): boolean {
  return row.title === entry.title
    && row.summary === entry.summary
    && row.data === JSON.stringify(entry.data)
    && row.tags === JSON.stringify(entry.tags);
}

/**
 * Commits the approved profile, the complete structured Story Deck, and the
 * ready stage in one SQLite transaction. If any write throws, none of the
 * visible brainstorm completion state is committed.
 */
export async function finalizeBrainstormAtomic(args: {
  novelId: string;
  profile: Partial<Novel>;
  entries: readonly BrainstormFinalizationEntry[];
}): Promise<FinalizeBrainstormResult> {
  const coverage = args.entries.reduce<Record<BrainstormFinalizationEntry['type'], number>>(
    (counts, entry) => {
      counts[entry.type] += 1;
      return counts;
    },
    { character: 0, world: 0, outline: 0 },
  );
  if (Object.values(coverage).some(count => count < 1)) {
    return { ok: false, reason: 'incomplete' };
  }

  const db = getDb();
  const tx = db.transaction((): FinalizeBrainstormResult => {
    const currentRow = db.prepare('SELECT stage FROM novels WHERE id = ?').get(args.novelId) as
      | { stage: string }
      | undefined;
    if (!currentRow) return { ok: false, reason: 'not_found' };
    if (!EDITABLE_STAGES.has(currentRow.stage)) {
      return { ok: false, reason: 'not_editable' };
    }

    const beforeNovel = applyNovelUpdate(db, args.novelId, {});
    if (!beforeNovel) return { ok: false, reason: 'not_found' };

    const mutations: BrainstormEntryMutation[] = [];
    for (const entry of args.entries) {
      const before = db.prepare(
        `SELECT * FROM knowledge_entries
          WHERE novel_id = ? AND type = ? AND lower(trim(title)) = ?
          ORDER BY updated_at DESC LIMIT 1`,
      ).get(args.novelId, entry.type, normalizedTitle(entry.title)) as KnowledgeEntryRow | undefined;
      const now = nowIso();
      let action: BrainstormEntryMutation['action'];
      let id: string;
      if (before) {
        id = before.id;
        action = sameEntry(before, entry) ? 'unchanged' : 'updated';
        if (action === 'updated') {
          db.prepare(
            `UPDATE knowledge_entries
                SET title = ?, summary = ?, data = ?, tags = ?, updated_at = ?
              WHERE id = ?`,
          ).run(
            entry.title,
            entry.summary,
            JSON.stringify(entry.data),
            JSON.stringify(entry.tags),
            now,
            id,
          );
        }
      } else {
        id = crypto.randomUUID();
        action = 'created';
        db.prepare(
          `INSERT INTO knowledge_entries
            (id, novel_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          args.novelId,
          entry.type,
          entry.title,
          entry.summary,
          JSON.stringify(entry.data),
          0,
          JSON.stringify(entry.tags),
          now,
          now,
        );
      }
      const after = db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as KnowledgeEntryRow;
      mutations.push({ action, before: before ?? null, after });
    }

    const novel = applyNovelUpdate(db, args.novelId, {
      ...args.profile,
      stage: 'ready_for_greenlight',
      progress: 0,
    });
    if (!novel) throw new Error('Novel disappeared during brainstorm finalization');
    return { ok: true, beforeNovel, novel, mutations, coverage };
  });
  return tx();
}
