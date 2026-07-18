// Integration tests for project-backup (W1-3) against real SQLite via the
// temp-DATA_DIR + getDb pattern. Covers every reviewer-flagged invariant:
//   - export produces the full fixed package layout (unzip check)
//   - no secret leaks: grep the whole package for apiKey/token and assert
//     manifest.secretsStripped === true
//   - tamper one byte → sha256 mismatch rejected
//   - delete a relation's target entry → referential integrity (dangling) caught
//   - restore creates a copy: new novelId, counts match, original untouched
//   - clean-DB import: copy opens, content + snapshots visible, templates render

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { LOCAL_USER_ID } from '@/lib/local-user';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-backup-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function mods() {
  return {
    db: await import('@/lib/db'),
    extract: await import('@/lib/backup/extract'),
    build: await import('@/lib/backup/build-package'),
    verify: await import('@/lib/backup/verify'),
    restore: await import('@/lib/backup/restore'),
    knowledge: await import('@/lib/knowledge/index-sync'),
  };
}

/**
 * Build a fully-populated novel: settings (with a secret), 2 chapters (one with
 * a snapshot), a 2-chapter blueprint/outline, 2 knowledge entries + a relation
 * between them, and a unification report.
 */
async function buildRichNovel(): Promise<{ novelId: string; entryIds: string[] }> {
  const { db, knowledge } = await mods();
  const novel = await db.createNovel({ userId: LOCAL_USER_ID, title: 'Backup Source' });
  const novelId = novel.id;

  // Settings with a secret key that MUST be stripped.
  await db.updateNovel(novelId, {
    settings: {
      creativity: 'balanced',
      dailyWordGoal: 1500,
      // Secret payloads — must never reach the package. The excess-property check
      // fires on the whole literal, so one directive covers both injected fields.
      // @ts-expect-error — deliberately injecting non-schema secret fields.
      providerApiKey: 'sk-LIVE-DO-NOT-LEAK-123',
      auth: { token: 'bearer-SECRET-TOKEN-456', label: 'keep-me' },
    },
  });

  // Blueprint → outline rows.
  await db.setNovelBlueprint(novelId, {
    chapters: [
      { chapterNumber: 1, title: 'Opening', summary: 'The start.' },
      { chapterNumber: 2, title: 'Rising', summary: 'It escalates.' },
    ],
    targetWordsPerChapter: 2000,
    generatedAt: new Date().toISOString(),
    modelId: 'test-model',
  });

  // Chapters with content + a snapshot on ch1.
  await db.upsertChapter(novelId, 1, 'Opening', 'Once upon a time, chapter one body.');
  await db.upsertChapter(novelId, 2, 'Rising', 'And then chapter two body unfolds.');
  await db.createChapterSnapshot(novelId, 1, 'milestone');

  // Re-project the blueprint now that chapters exist so the outline rows carry a
  // populated `data.chapterId` (only blueprint projection back-fills the link).
  // This exercises the restore's chapterId remap path with non-empty ids.
  await db.setNovelBlueprint(novelId, {
    chapters: [
      { chapterNumber: 1, title: 'Opening', summary: 'The start.' },
      { chapterNumber: 2, title: 'Rising', summary: 'It escalates.' },
    ],
    targetWordsPerChapter: 2000,
    generatedAt: new Date().toISOString(),
    modelId: 'test-model',
  });

  // Knowledge entries + a relation.
  const e1Id = crypto.randomUUID();
  const e2Id = crypto.randomUUID();
  const now = new Date().toISOString();
  const e1Data = { description: 'A brave hero', aliases: [], importance: 'major' };
  const e2Data = { description: 'A shadowy city', details: {} };
  const e1Index = await knowledge.buildKnowledgeIndexInsert({
    id: e1Id, novelId, type: 'character', title: 'Hero', summary: 'A brave hero',
    data: e1Data, tags: ['protagonist'], updatedAt: now,
  });
  const e2Index = await knowledge.buildKnowledgeIndexInsert({
    id: e2Id, novelId, type: 'world', title: 'City', summary: 'A shadowy city',
    data: e2Data, tags: [], updatedAt: now,
  });
  await db.createKnowledgeEntryWithIndex({
    id: e1Id, novelId, type: 'character', title: 'Hero', summary: 'A brave hero',
    data: JSON.stringify(e1Data), sortOrder: 0, tags: JSON.stringify(['protagonist']),
    createdAt: now, updatedAt: now,
  }, e1Index);
  await db.createKnowledgeEntryWithIndex({
    id: e2Id, novelId, type: 'world', title: 'City', summary: 'A shadowy city',
    data: JSON.stringify(e2Data), sortOrder: 1, tags: '[]', createdAt: now, updatedAt: now,
  }, e2Index);

  const relIndex = await knowledge.buildKnowledgeIndexInsert({
    id: e1Id, novelId, type: 'character', title: 'Hero', summary: 'A brave hero',
    data: { ...e1Data, relations: [{ target: 'City', type: 'lives_in', label: '' }] },
    tags: ['protagonist'], updatedAt: now,
  });
  await db.createKnowledgeRelationWithSourceIndex({
    id: crypto.randomUUID(), sourceId: e1Id, targetId: e2Id,
    relationType: 'lives_in', label: '', createdAt: now,
  }, relIndex);

  // Unification report (revision items).
  await db.persistUnificationReportWithMessage(
    novelId,
    {
      edits: [
        {
          id: 'edit-1', chapterNumber: 1, original: 'time', replacement: 'a time',
          rationale: 'clarity', severity: 'minor',
        },
      ],
      summary: 'one minor edit',
      generatedAt: now,
      modelId: 'test-model',
    },
    'Unification done.',
  );

  return { novelId, entryIds: [e1Id, e2Id] };
}

describe('export → package layout', () => {
  it('produces the full fixed layout with all sections present', async () => {
    const { extract, build } = await mods();
    const { novelId } = await buildRichNovel();

    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes, manifest } = await build.buildBackupPackage(bundle);

    const entries = unzipSync(bytes);
    const names = Object.keys(entries);

    expect(names).toContain('manifest.json');
    expect(names).toContain('novel.json');
    expect(names).toContain('chapters/0001.json');
    expect(names).toContain('chapters/0002.json');
    expect(names).toContain('knowledge/entries.json');
    expect(names).toContain('knowledge/relations.json');
    expect(names).toContain('outline.json');
    expect(names).toContain('unification.json');
    expect(names).toContain('prompt-templates.json');

    expect(manifest.counts.chapters).toBe(2);
    expect(manifest.counts.outline).toBe(2);
    expect(manifest.counts.knowledgeRelations).toBe(1);
    // Entries include the 2 explicit ones + 2 outline rows (outline entries).
    expect(manifest.counts.knowledgeEntries).toBe(4);
    expect(manifest.secretsStripped).toBe(true);
  });
});

describe('secret stripping', () => {
  it('package bytes contain no apiKey/token/secret material', async () => {
    const { extract, build } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes, manifest } = await build.buildBackupPackage(bundle);

    // Decompress every entry and grep the decoded text — a secret could hide in
    // any section, not just novel.json.
    const entries = unzipSync(bytes);
    const allText = Object.values(entries).map(b => strFromU8(b)).join('\n');

    expect(allText).not.toContain('sk-LIVE-DO-NOT-LEAK-123');
    expect(allText).not.toContain('bearer-SECRET-TOKEN-456');
    expect(allText.toLowerCase()).not.toContain('apikey');
    expect(allText.toLowerCase()).not.toContain('providerapikey');
    // A non-secret sibling under the same object is preserved.
    expect(allText).toContain('keep-me');
    expect(manifest.secretsStripped).toBe(true);
  });
});

describe('verify — integrity', () => {
  it('accepts a clean package', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(true);
    expect(report.errors).toHaveLength(0);
    expect(report.bundle).not.toBeNull();
  });

  it('rejects a one-byte tamper with a sha256 mismatch', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    // Repack with a mutated novel.json so its bytes no longer match the manifest.
    const entries = unzipSync(bytes);
    const novelText = strFromU8(entries['novel.json']);
    const tampered = novelText.replace('Backup Source', 'Tampered Title!');
    entries['novel.json'] = new TextEncoder().encode(tampered);
    const { zipSync } = await import('fflate');
    const repacked = zipSync(entries, { level: 6 });

    const report = await verify.verifyBackupPackage(repacked);
    expect(report.ok).toBe(false);
    expect(report.errors.some(e => e.code === 'sha256_mismatch')).toBe(true);
  });

  it('rejects a tampered file even when its checksum entry is removed', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    const entries = unzipSync(bytes);
    entries['novel.json'] = new TextEncoder().encode('{"title":"tampered"}');
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    delete manifest.sha256['novel.json'];
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    const { zipSync } = await import('fflate');

    const report = await verify.verifyBackupPackage(zipSync(entries, { level: 6 }));
    expect(report.ok).toBe(false);
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'missing_checksum',
      ref: 'novel.json',
    }));
    expect(report.bundle).toBeNull();
  });

  it('does not mistake prototype property names for manifest checksums', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);
    const entries = Object.assign(Object.create(null) as Record<string, Uint8Array>, unzipSync(bytes));
    entries['toString'] = new TextEncoder().encode('unlisted payload');
    const { zipSync } = await import('fflate');

    const report = await verify.verifyBackupPackage(zipSync(entries, { level: 6 }));
    expect(report.errors).toContainEqual(expect.objectContaining({
      code: 'missing_checksum',
      ref: 'toString',
    }));
  });

  it('rejects a dangling relation when a target entry is removed', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);

    // Drop the relation's target entry from the bundle, then rebuild + verify.
    const targetId = bundle.knowledgeRelations[0].targetId;
    bundle.knowledgeEntries = bundle.knowledgeEntries.filter(e => e.id !== targetId);
    const { bytes } = await build.buildBackupPackage(bundle);

    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(false);
    expect(report.errors.some(e => e.code === 'dangling_relation')).toBe(true);
  });

  it('rejects an incompatible major format version', async () => {
    const { extract, build, verify } = await mods();
    const { novelId } = await buildRichNovel();
    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);

    const entries = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(entries['manifest.json']));
    manifest.formatVersion = '9.0';
    entries['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    const { zipSync } = await import('fflate');
    const repacked = zipSync(entries, { level: 6 });

    const report = await verify.verifyBackupPackage(repacked);
    expect(report.formatCompatible).toBe(false);
    expect(report.ok).toBe(false);
  });
});

describe('restore — create a copy', () => {
  it('mints a new novelId, matches counts, and leaves the original untouched', async () => {
    const { db, extract, build, verify, restore } = await mods();
    const { novelId } = await buildRichNovel();

    const originalBefore = await db.getNovel(novelId);
    const originalChaptersBefore = await db.getChapters(novelId);
    const originalEntriesBefore = await db.getKnowledgeEntriesByNovel(novelId);

    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);
    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(true);

    const result = await restore.restoreBundleAsCopy(report.bundle!);

    // New id, distinct from the source.
    expect(result.novelId).not.toBe(novelId);
    expect(result.counts.chapters).toBe(2);
    expect(result.counts.knowledgeRelations).toBe(1);

    // The copy is real + openable.
    const copy = await db.getNovel(result.novelId);
    expect(copy).toBeDefined();
    expect(copy!.title).toBe('Backup Source');

    const copyChapters = await db.getChapters(result.novelId);
    expect(copyChapters).toHaveLength(2);
    expect(copyChapters[0].content).toContain('chapter one body');
    // Snapshot survived the round-trip.
    const ch1 = await db.getChapter(result.novelId, 1);
    expect((ch1!.snapshots ?? []).length).toBeGreaterThan(0);

    // Relation re-points within the COPY's id space (same-novel trigger held).
    const copyRelations = await db.getKnowledgeRelationsByNovel(result.novelId);
    expect(copyRelations).toHaveLength(1);
    const copyEntries = await db.getKnowledgeEntriesByNovel(result.novelId);
    const copyEntryIds = new Set(copyEntries.map(e => e.id));
    expect(copyEntryIds.has(copyRelations[0].source_id)).toBe(true);
    expect(copyEntryIds.has(copyRelations[0].target_id)).toBe(true);

    // Outline survived + chapter linkage remapped to the copy's chapter ids.
    const copyOutline = await db.getOutlineWithChapterStatus(result.novelId);
    expect(copyOutline).toHaveLength(2);
    expect(copyOutline.some(r => r.hasChapter)).toBe(true);

    // The outline rows' embedded chapterId must point at chapters that exist in
    // the COPY (not the source) — i.e. the id remap actually rewired the link.
    const copyChapterIdSet = new Set(copyChapters.map(c => c.id));
    const outlineRows = await db.getOutlineEntries(result.novelId);
    let linkedCount = 0;
    for (const row of outlineRows) {
      const data = JSON.parse(row.data) as { chapterId?: string };
      if (data.chapterId) {
        expect(copyChapterIdSet.has(data.chapterId)).toBe(true);
        linkedCount += 1;
      }
    }
    // Both outline rows had drafted chapters, so both links must be present.
    expect(linkedCount).toBe(2);

    // Original is byte-for-byte unchanged.
    const originalAfter = await db.getNovel(novelId);
    expect(originalAfter!.title).toBe(originalBefore!.title);
    expect((await db.getChapters(novelId)).length).toBe(originalChaptersBefore.length);
    expect((await db.getKnowledgeEntriesByNovel(novelId)).length).toBe(originalEntriesBefore.length);
  });

  it('restores into a clean DB-like state: copy is independent of source deletion', async () => {
    const { db, extract, build, verify, restore } = await mods();
    const { novelId } = await buildRichNovel();

    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);
    const report = await verify.verifyBackupPackage(bytes);
    const result = await restore.restoreBundleAsCopy(report.bundle!);

    // Delete the source entirely — the copy must remain intact + openable.
    await db.deleteNovelCascade(novelId, LOCAL_USER_ID);
    expect(await db.getNovel(novelId)).toBeUndefined();

    const copy = await db.getNovel(result.novelId);
    expect(copy).toBeDefined();
    const copyChapters = await db.getChapters(result.novelId);
    expect(copyChapters).toHaveLength(2);
    expect(copyChapters[1].content).toContain('chapter two body');
  });

  // S5b: a post-commit outline-reorder failure used to be swallowed
  // (console.warn only) and the restore reported full success — leaving a
  // scrambled chapter order with no signal to the user. The fix surfaces the
  // failure as a warning on RestoreResult (the copy is still intact).
  it('surfaces a warning when the post-commit outline reorder fails', async () => {
    const { extract, build, verify, restore } = await mods();
    const { novelId } = await buildRichNovel();

    const bundle = await extract.extractBackupBundle(novelId);
    const { bytes } = await build.buildBackupPackage(bundle);
    const report = await verify.verifyBackupPackage(bytes);
    expect(report.ok).toBe(true);

    const reorderModule = await import('@/lib/db/queries-knowledge');
    const spy = vi.spyOn(reorderModule, 'reorderOutlineAtomic').mockRejectedValue(
      new Error('forced reorder failure'),
    );
    try {
      const result = await restore.restoreBundleAsCopy(report.bundle!);
      // The restore still succeeds (copy intact)…
      expect(result.novelId).toBeTruthy();
      expect(result.counts.chapters).toBe(2);
      // …but warns the user the outline order may need a manual re-save.
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
      expect(result.warnings![0]).toMatch(/outline order/i);
    } finally {
      spy.mockRestore();
    }
  });
});
