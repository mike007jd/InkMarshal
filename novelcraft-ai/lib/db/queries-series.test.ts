import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-series-query-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedSharedEntry(novelId: string, seriesId: string, title: string, data: Record<string, unknown>) {
  const { getDb } = await import('@/lib/db/connection');
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge_entries
       (id, novel_id, series_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
     VALUES (?, ?, ?, 'character', ?, '', ?, 0, '[]', ?, ?)`,
  ).run(id, novelId, seriesId, title, JSON.stringify(data), now, now);
  return id;
}

async function listShared(novelId: string) {
  const { listKnowledgeIndexForNovel } = await import('@/lib/db/queries-knowledge-vault');
  const rows = await listKnowledgeIndexForNovel(novelId);
  return rows.filter(r => r.path.startsWith('shared/'));
}

describe('queries-series: projection + cascade', () => {
  it('projects shared entries into every member novel under shared/ and merges overrides', async () => {
    const { createNovel } = await import('@/lib/db');
    const {
      createSeries, setNovelSeries, reprojectSharedEntriesForSeries, setEntryData,
    } = await import('@/lib/db/queries-series');

    const bookA = await createNovel({ userId: 'local-user', title: 'Book A' });
    const bookB = await createNovel({ userId: 'local-user', title: 'Book B' });
    const seriesId = crypto.randomUUID();
    await createSeries({ id: seriesId, userId: 'local-user', title: 'Saga' });
    await setNovelSeries(bookA.id, seriesId);
    await setNovelSeries(bookB.id, seriesId);

    const entryId = await seedSharedEntry(bookA.id, seriesId, 'Hero', { description: 'Stoic.' });

    await reprojectSharedEntriesForSeries(seriesId);

    // Each member novel gets exactly one shared projection row.
    const aRows = await listShared(bookA.id);
    const bRows = await listShared(bookB.id);
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].id).toBe(`${entryId}::${bookA.id}`);
    expect(bRows[0].id).toBe(`${entryId}::${bookB.id}`);
    expect(aRows[0].data.description).toBe('Stoic.');
    expect(bRows[0].data.description).toBe('Stoic.');

    // Add a per-novel override for Book B only, reproject, and confirm only B's
    // projected view changed.
    await setEntryData(entryId, JSON.stringify({
      description: 'Stoic.',
      perNovelOverrides: { [bookB.id]: { description: 'Reckless.' } },
    }));
    await reprojectSharedEntriesForSeries(seriesId);

    const aRows2 = await listShared(bookA.id);
    const bRows2 = await listShared(bookB.id);
    expect(aRows2[0].data.description).toBe('Stoic.');
    expect(bRows2[0].data.description).toBe('Reckless.');
    // Overlay bags never leak into the projection.
    expect(aRows2[0].data.perNovelOverrides).toBeUndefined();
    expect(bRows2[0].data.perNovelOverrides).toBeUndefined();
  });

  it('rebuild replaces shared/ rows (delete-then-write) — no stale rows after unshare', async () => {
    const { createNovel } = await import('@/lib/db');
    const {
      createSeries, setNovelSeries, reprojectSharedEntriesForSeries, setEntrySeriesId,
    } = await import('@/lib/db/queries-series');

    const book = await createNovel({ userId: 'local-user', title: 'Solo Saga Book' });
    const seriesId = crypto.randomUUID();
    await createSeries({ id: seriesId, userId: 'local-user', title: 'Solo Saga' });
    await setNovelSeries(book.id, seriesId);

    const entryId = await seedSharedEntry(book.id, seriesId, 'Sidekick', { description: 'Loyal.' });
    await reprojectSharedEntriesForSeries(seriesId);
    expect(await listShared(book.id)).toHaveLength(1);

    // Unshare (clear series_id) + reproject → the shared/ row is gone.
    await setEntrySeriesId(entryId, null);
    await reprojectSharedEntriesForSeries(seriesId);
    expect(await listShared(book.id)).toHaveLength(0);
  });

  it('deleteSeriesCascade removes shared entries + projections but keeps member novels + private entries', async () => {
    const { createNovel, getNovel } = await import('@/lib/db');
    const { getKnowledgeEntryById } = await import('@/lib/db/queries-knowledge');
    const { getDb } = await import('@/lib/db/connection');
    const {
      createSeries, setNovelSeries, reprojectSharedEntriesForSeries, deleteSeriesCascade,
    } = await import('@/lib/db/queries-series');

    const book = await createNovel({ userId: 'local-user', title: 'Cascade Book' });
    const seriesId = crypto.randomUUID();
    await createSeries({ id: seriesId, userId: 'local-user', title: 'Cascade Saga' });
    await setNovelSeries(book.id, seriesId);

    // One shared + one private entry on the same book.
    const sharedId = await seedSharedEntry(book.id, seriesId, 'Shared Hero', { description: 'shared' });
    const privateId = await seedSharedEntry(book.id, null as unknown as string, 'Private Note', { description: 'private' });
    await reprojectSharedEntriesForSeries(seriesId);
    expect(await listShared(book.id)).toHaveLength(1);

    const { memberNovelIds } = await deleteSeriesCascade(seriesId);
    expect(memberNovelIds).toContain(book.id);

    // Series gone, member novel intact + un-linked, projection rows gone.
    const seriesGone = getDb().prepare('SELECT id FROM series WHERE id = ?').get(seriesId);
    expect(seriesGone).toBeUndefined();
    const novel = await getNovel(book.id);
    expect(novel).toBeTruthy();
    expect(await listShared(book.id)).toHaveLength(0);

    // Shared entry removed; private entry survives.
    expect(await getKnowledgeEntryById(sharedId)).toBeUndefined();
    expect(await getKnowledgeEntryById(privateId)).toBeTruthy();
  });
});
