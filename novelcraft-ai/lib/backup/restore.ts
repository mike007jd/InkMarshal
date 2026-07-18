// Project-backup (W1-3) — restore a verified BackupBundle as a NEW novel.
//
// Always "create a copy": mint a fresh novelId and remap EVERY id (knowledge
// entries, relations, outline chapterId links, chapters) into the new id space.
// We never offer "overwrite the original" — that would break optimistic-lock
// versions and foreign keys and is irreversible.
//
// Atomicity: all id remapping is pre-computed in JS (and the knowledge_index
// rows are hashed) BEFORE opening a single synchronous better-sqlite3 write
// transaction. If any required mapping is missing we throw before the
// transaction, or the transaction itself rolls back the whole novel — there is
// never a half-restored book. After commit we run reorderOutlineAtomic to
// resync the outline sort order + chapterNumber + vault mirror.

import { getDb } from '@/lib/db/connection';
import { nowIso } from '@/lib/utils';
import { LOCAL_USER_ID } from '@/lib/local-user';
import {
  KNOWLEDGE_INDEX_UPSERT_SQL,
  knowledgeIndexParams,
  type KnowledgeIndexInsert,
} from '@/lib/db/queries-vault';
import { buildKnowledgeIndexInsert } from '@/lib/knowledge/index-sync';
import { reorderOutlineAtomic } from '@/lib/db/queries-knowledge';
import { JSON_COLUMN_VERSIONS } from '@/lib/db/json-columns';
import type { KnowledgeType } from '@/lib/types/knowledge';
import type { BackupBundle, BackupKnowledgeEntry } from '@/lib/backup/types';

export interface RestoreResult {
  novelId: string;
  title: string;
  counts: {
    chapters: number;
    knowledgeEntries: number;
    knowledgeRelations: number;
    outline: number;
  };
  /** Non-fatal post-restore issues (e.g. outline reorder failed — the copy is
   *  intact but the chapter order may need a manual re-save). Empty when the
   *  restore completed cleanly. */
  warnings?: string[];
}

/** Parse a JSON-text column to an object, tolerating corrupt/empty values. */
function safeObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function safeStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Restore `bundle` into a brand-new novel owned by the local user. Returns the
 * new novelId + counts. Throws (and leaves the DB untouched) on any structural
 * inconsistency — verify should have caught these, but restore re-checks every
 * mapping so a hand-edited package can never produce orphans.
 */
export async function restoreBundleAsCopy(bundle: BackupBundle): Promise<RestoreResult> {
  const db = getDb();
  const now = nowIso();
  const newNovelId = crypto.randomUUID();

  // --- Build id remaps (pure) -------------------------------------------------
  // entry id -> new id; chapter old-id -> new chapter (we key chapters by number
  // since the package stores chapterId only inside outline rows).
  const entryIdMap = new Map<string, string>();
  for (const e of bundle.knowledgeEntries) entryIdMap.set(e.id, crypto.randomUUID());

  // old chapterId -> chapterNumber, so an outline row's chapterId remaps to the
  // restored chapter's new id by looking up its number.
  const oldChapterIdToNumber = new Map<string, number>();
  for (const row of bundle.outline) {
    if (row.chapterId) oldChapterIdToNumber.set(row.chapterId, row.chapterNumber);
  }
  // chapterNumber -> new chapter id.
  const chapterNumberToNewId = new Map<number, string>();
  for (const ch of bundle.chapters) chapterNumberToNewId.set(ch.chapterNumber, crypto.randomUUID());

  // Resolve an old chapterId to a new chapter id (or '' when unlinked / missing).
  const remapChapterId = (oldChapterId: string): string => {
    if (!oldChapterId) return '';
    const number = oldChapterIdToNumber.get(oldChapterId);
    if (number === undefined) return ''; // outline row had no number mapping → unlink
    return chapterNumberToNewId.get(number) ?? '';
  };

  // --- Validate relation endpoints map (fail fast, before any write) ----------
  for (const rel of bundle.knowledgeRelations) {
    if (!entryIdMap.has(rel.sourceId) || !entryIdMap.has(rel.targetId)) {
      throw new Error(
        `Restore aborted: relation ${rel.id} references an entry not present in the package (dangling).`,
      );
    }
  }

  // --- Pre-compute knowledge_index rows (async hashing) for non-outline AND
  //     outline entries, with remapped data (chapterId for outline rows) -------
  type PreparedEntry = {
    newId: string;
    src: BackupKnowledgeEntry;
    /** Entry `data` JSON with chapterId remapped (outline) — stored verbatim. */
    dataJson: string;
    index: KnowledgeIndexInsert;
  };

  const preparedEntries: PreparedEntry[] = [];
  for (const e of bundle.knowledgeEntries) {
    const newId = entryIdMap.get(e.id)!;
    const data = safeObject(e.data);

    if (e.type === 'outline') {
      // Remap the chapterId link to the new chapter id space.
      const oldChapterId = typeof data.chapterId === 'string' ? data.chapterId : '';
      data.chapterId = remapChapterId(oldChapterId);
    }
    const dataJson = JSON.stringify(data);

    // Build the knowledge_index mirror row from the canonical fields. We pass the
    // FINAL new id + remapped data so the index points at the restored entry.
    const index = await buildKnowledgeIndexInsert({
      id: newId,
      novelId: newNovelId,
      type: e.type as KnowledgeType,
      title: e.title,
      summary: e.summary,
      data,
      tags: safeStringArray(e.tags),
      updatedAt: e.updatedAt || now,
    });

    preparedEntries.push({ newId, src: e, dataJson, index });
  }

  // --- Single synchronous write transaction (all-or-nothing) ------------------
  const insertNovel = db.prepare(
    `INSERT INTO novels (
       id, user_id, title, genre, target_words, stage, progress,
       story_summary, character_summary, arc_summary,
       interview_state, interview_state_v,
       unification_report, unification_report_v,
       settings,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertChapter = db.prepare(
    `INSERT INTO chapters (
       id, novel_id, chapter_number, title, content, original_content,
       word_count, version, summary,
       key_facts, key_facts_v, quality_issues, quality_issues_v,
       generation_meta, generation_meta_v, snapshots, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEntry = db.prepare(
    `INSERT INTO knowledge_entries
       (id, novel_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRelation = db.prepare(
    `INSERT INTO knowledge_relations
       (id, source_id, target_id, relation_type, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const upsertIndex = db.prepare(KNOWLEDGE_INDEX_UPSERT_SQL);

  // Prompt-template restore statements. prompt_templates is a GLOBAL table; we
  // never overwrite a live active row. For each backed-up template we keep the
  // installed active text as-is if it already matches, otherwise we insert a new
  // INACTIVE row at version = max+1 so the package's text is preserved without
  // disturbing the user's active template.
  const findActiveTemplate = db.prepare(
    `SELECT template_text FROM prompt_templates
      WHERE stage = ? AND role = ? AND locale = ? AND variant = ? AND active = 1
      ORDER BY version DESC LIMIT 1`,
  );
  const maxTemplateVersion = db.prepare(
    `SELECT COALESCE(MAX(version), 0) AS v FROM prompt_templates
      WHERE stage = ? AND role = ? AND locale = ? AND variant = ?`,
  );
  const insertTemplate = db.prepare(
    `INSERT INTO prompt_templates
       (id, stage, role, locale, version, variant, template_text, variables_schema, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    // 1. Novel.
    const n = bundle.novel;
    const interviewState = n.interviewState ?? null;
    const unification = bundle.unificationReport ?? null;
    insertNovel.run(
      newNovelId,
      LOCAL_USER_ID,
      n.title,
      n.genre,
      n.targetWords,
      n.stage,
      n.progress,
      n.storySummary,
      n.characterSummary,
      n.arcSummary,
      interviewState === null ? null : JSON.stringify(interviewState),
      interviewState === null ? null : JSON_COLUMN_VERSIONS.interview_state,
      unification === null ? null : JSON.stringify(unification),
      unification === null ? null : JSON_COLUMN_VERSIONS.unification_report,
      n.settings === null ? null : JSON.stringify(n.settings),
      n.createdAt ? new Date(n.createdAt).toISOString() : now,
      now,
    );

    // 2. Chapters.
    for (const ch of bundle.chapters) {
      const newChapterId = chapterNumberToNewId.get(ch.chapterNumber);
      if (!newChapterId) {
        throw new Error(`Restore aborted: missing chapter id mapping for chapter ${ch.chapterNumber}.`);
      }
      insertChapter.run(
        newChapterId,
        newNovelId,
        ch.chapterNumber,
        ch.title,
        ch.content,
        ch.originalContent ?? null,
        ch.wordCount,
        ch.version ?? 0,
        ch.summary ?? '',
        ch.keyFacts === null || ch.keyFacts === undefined ? null : JSON.stringify(ch.keyFacts),
        ch.keyFacts === null || ch.keyFacts === undefined ? null : JSON_COLUMN_VERSIONS.key_facts,
        ch.qualityIssues === null || ch.qualityIssues === undefined ? null : JSON.stringify(ch.qualityIssues),
        ch.qualityIssues === null || ch.qualityIssues === undefined ? null : JSON_COLUMN_VERSIONS.quality_issues,
        ch.generationMeta === null || ch.generationMeta === undefined ? null : JSON.stringify(ch.generationMeta),
        ch.generationMeta === null || ch.generationMeta === undefined ? null : JSON_COLUMN_VERSIONS.generation_meta,
        ch.snapshots === null || ch.snapshots === undefined ? null : JSON.stringify(ch.snapshots),
        ch.createdAt ? new Date(ch.createdAt).toISOString() : now,
      );
    }

    // 3. Knowledge entries (all types incl. outline) + their index mirror.
    for (const p of preparedEntries) {
      insertEntry.run(
        p.newId,
        newNovelId,
        p.src.type,
        p.src.title,
        p.src.summary,
        p.dataJson,
        p.src.sortOrder,
        p.src.tags || '[]',
        p.src.createdAt || now,
        p.src.updatedAt || now,
      );
      upsertIndex.run(...knowledgeIndexParams(p.index));
    }

    // 4. Relations — both endpoints already validated to be in the entry map, and
    //    both remap into the SAME new novel, so the same-novel relation trigger
    //    (source/target must share a novel) passes.
    for (const rel of bundle.knowledgeRelations) {
      const newSource = entryIdMap.get(rel.sourceId);
      const newTarget = entryIdMap.get(rel.targetId);
      if (!newSource || !newTarget) {
        throw new Error(`Restore aborted: relation ${rel.id} endpoint mapping missing.`);
      }
      insertRelation.run(
        crypto.randomUUID(),
        newSource,
        newTarget,
        rel.relationType,
        rel.label,
        rel.createdAt || now,
      );
    }

    // 5. Prompt templates (global table). Never overwrite the active row.
    for (const t of bundle.promptTemplates) {
      const active = findActiveTemplate.get(t.stage, t.role, t.locale, t.variant) as
        | { template_text: string }
        | undefined;
      if (active && active.template_text === t.templateText) {
        continue; // Identical text already installed and active — no-op.
      }
      const maxRow = maxTemplateVersion.get(t.stage, t.role, t.locale, t.variant) as { v: number };
      const nextVersion = (maxRow?.v ?? 0) + 1;
      // Insert as inactive when an active row already exists (don't disturb the
      // user's live template); as active when nothing is installed for this key.
      insertTemplate.run(
        crypto.randomUUID(),
        t.stage,
        t.role,
        t.locale,
        nextVersion,
        t.variant,
        t.templateText,
        t.variablesSchema || '{}',
        active ? 0 : 1,
        now,
      );
    }
  });

  tx();

  // --- Post-commit: resync outline order + chapterNumber + vault mirror -------
  // reorderOutlineAtomic requires EXACTLY the full set of the new novel's
  // outline entries, in the desired order — passing a subset throws "Invalid
  // outline order". So derive the id list from the entries we actually inserted
  // (the canonical set), and use the backed-up outline rows only to supply a
  // sort priority (falling back to each entry's own sortOrder). This stays
  // correct even if a hand-edited package's outline.json and entries.json drift.
  const outlinePriority = new Map<string, number>(); // newEntryId -> priority
  for (const row of bundle.outline) {
    const newId = entryIdMap.get(row.entryId);
    if (newId) outlinePriority.set(newId, row.sortOrder);
  }
  const insertedOutlineEntryIds = preparedEntries
    .filter(p => p.src.type === 'outline')
    .map(p => ({ id: p.newId, priority: outlinePriority.get(p.newId) ?? p.src.sortOrder }))
    .sort((a, b) => a.priority - b.priority)
    .map(p => p.id);

  // Post-commit and best-effort: the novel + chapters + knowledge already
  // committed atomically in tx(). A reorder failure here must NOT surface as
  // "restore failed" (that would falsely imply nothing was created and leave the
  // user with an orphan novel they can't find) — the copy is intact and
  // openable; only the outline sort order is approximate and re-settles on the
  // next outline edit / blueprint pass. It IS surfaced as a warning on the
  // result so the UI can tell the user the chapter order may need a re-save,
  // rather than reporting a silently-imperfect restore as fully clean.
  const warnings: string[] = [];
  if (insertedOutlineEntryIds.length > 0) {
    try {
      await reorderOutlineAtomic(newNovelId, insertedOutlineEntryIds);
    } catch (err) {
      console.warn('backup restore: outline reorder failed post-commit (copy is intact):', err);
      warnings.push(
        'Outline order could not be restored automatically — open the outline and re-save to fix the chapter sequence.',
      );
    }
  }

  return {
    novelId: newNovelId,
    title: bundle.novel.title,
    counts: {
      chapters: bundle.chapters.length,
      knowledgeEntries: bundle.knowledgeEntries.length,
      knowledgeRelations: bundle.knowledgeRelations.length,
      outline: bundle.outline.length,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
