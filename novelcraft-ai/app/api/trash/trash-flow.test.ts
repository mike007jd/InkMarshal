import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-trash-flow-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('canonical Trash flow', () => {
  it('hides an intact book, blocks ordinary APIs, restores it, and only then allows explicit permanent deletion', async () => {
    const db = await import('@/lib/db');
    const { DELETE: moveToTrash, GET: getNovelRoute } = await import('@/app/api/novels/[id]/route');
    const { GET: listActive } = await import('@/app/api/novels/route');
    const { GET: listTrash } = await import('@/app/api/trash/route');
    const { POST: restore } = await import('@/app/api/trash/[id]/restore/route');
    const { DELETE: deletePermanently } = await import('@/app/api/trash/[id]/route');
    const { createConversation } = await import('@/app/actions/conversations');
    const { createKnowledgeEntry, updateKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { getSeriesDetail, runCrossBookCheck, shareKnowledgeEntry, unshareKnowledgeEntry } = await import('@/app/actions/series');
    const { listKnowledgeIndexForNovel } = await import('@/lib/db/queries-knowledge-vault');
    const { setNovelVaultPath } = await import('@/lib/db/queries-vault');
    const seriesDb = await import('@/lib/db/queries-series');
    const novel = await db.createNovel({
      userId: 'local-user',
      title: 'Keep Every Word',
    });
    await db.updateNovel(novel.id, { settings: { creativity: 'wild' } });
    await db.upsertChapter(novel.id, 1, 'Opening', 'Content must survive Trash.');
    const seriesId = crypto.randomUUID();
    await seriesDb.createSeries({ id: seriesId, userId: 'local-user', title: 'Still Together' });
    await seriesDb.setNovelSeries(novel.id, seriesId);
    const activeSibling = await db.createNovel({ userId: 'local-user', title: 'Visible Sibling' });
    await seriesDb.setNovelSeries(activeSibling.id, seriesId);
    const sharedEntry = await createKnowledgeEntry(novel.id, {
      type: 'character',
      title: 'Hidden Anchor',
      data: {
        role: 'protagonist',
        description: 'Shared before Trash.',
        backstory: '',
        motivation: 'Protect the boundary.',
        traits: ['careful'],
        arc: 'steady',
      },
      tags: [],
    });
    await shareKnowledgeEntry(seriesId, sharedEntry.id);
    expect((await listKnowledgeIndexForNovel(activeSibling.id)).some(row => row.id === `${sharedEntry.id}::${activeSibling.id}`)).toBe(true);
    const params = { params: Promise.resolve({ id: novel.id }) };

    const moved = await moveToTrash(new Request(`http://localhost/api/novels/${novel.id}`, { method: 'DELETE' }), params);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ ok: true, trashed: true });

    const stored = await db.getNovel(novel.id);
    expect(stored?.settings).toMatchObject({ creativity: 'wild', trashedAt: expect.any(String) });
    expect((await db.getChapter(novel.id, 1))?.content).toBe('Content must survive Trash.');
    expect((await listActive().then(response => response.json()) as Array<{ id: string }>).some(item => item.id === novel.id)).toBe(false);
    expect((await listTrash().then(response => response.json()) as Array<{ id: string }>).map(item => item.id)).toContain(novel.id);
    expect((await getNovelRoute(new Request(`http://localhost/api/novels/${novel.id}`), params)).status).toBe(404);
    await expect(db.verifyNovelOwnership(novel.id, 'local-user')).rejects.toThrow('Not found');
    await expect(createConversation(novel.id, { title: 'Ghost edit' })).rejects.toThrow('Not found');
    await expect(updateKnowledgeEntry(sharedEntry.id, { title: 'Ghost knowledge edit' })).rejects.toThrow('Not found');
    await expect(unshareKnowledgeEntry(seriesId, sharedEntry.id)).rejects.toThrow('Not found');
    expect((await getSeriesDetail(seriesId)).members).not.toContainEqual(expect.objectContaining({ id: novel.id }));
    expect((await getSeriesDetail(seriesId)).sharedEntries).not.toContainEqual(expect.objectContaining({ id: sharedEntry.id }));
    expect((await runCrossBookCheck(seriesId)).novelTitles).not.toHaveProperty(novel.id);
    expect((await seriesDb.listSeriesMembers(seriesId)).map(item => item.id)).toContain(novel.id);
    expect((await listKnowledgeIndexForNovel(activeSibling.id)).some(row => row.id === `${sharedEntry.id}::${activeSibling.id}`)).toBe(false);

    const restored = await restore(new Request(`http://localhost/api/trash/${novel.id}/restore`, { method: 'POST' }), params);
    expect(restored.status).toBe(200);
    expect((await db.getNovel(novel.id))?.settings).toMatchObject({ creativity: 'wild' });
    expect((await db.getNovel(novel.id))?.settings?.trashedAt).toBeUndefined();
    expect((await listActive().then(response => response.json()) as Array<{ id: string }>).map(item => item.id)).toContain(novel.id);
    expect((await getSeriesDetail(seriesId)).members).toContainEqual(expect.objectContaining({ id: novel.id }));
    expect((await getSeriesDetail(seriesId)).sharedEntries).toContainEqual(expect.objectContaining({ id: sharedEntry.id }));
    expect((await listKnowledgeIndexForNovel(activeSibling.id)).some(row => row.id === `${sharedEntry.id}::${activeSibling.id}`)).toBe(true);

    // Permanent delete is rejected while the book is active.
    expect((await deletePermanently(new Request(`http://localhost/api/trash/${novel.id}`, { method: 'DELETE' }), params)).status).toBe(404);
    expect(await db.getNovel(novel.id)).toBeDefined();

    await moveToTrash(new Request(`http://localhost/api/novels/${novel.id}`, { method: 'DELETE' }), params);
    const ownedVault = path.join(tmpDir, 'vaults', novel.id);
    mkdirSync(ownedVault, { recursive: true });
    writeFileSync(path.join(ownedVault, 'notes.md'), 'delete with the book');
    await setNovelVaultPath(novel.id, ownedVault);
    const deleted = await deletePermanently(new Request(`http://localhost/api/trash/${novel.id}`, { method: 'DELETE' }), params);
    expect(deleted.status).toBe(200);
    expect(await db.getNovel(novel.id)).toBeUndefined();
    expect(existsSync(ownedVault)).toBe(false);
  });

  it('never deletes an external Vault during permanent book deletion', async () => {
    const db = await import('@/lib/db');
    const { DELETE: moveToTrash } = await import('@/app/api/novels/[id]/route');
    const { DELETE: deletePermanently } = await import('@/app/api/trash/[id]/route');
    const { setNovelVaultPath } = await import('@/lib/db/queries-vault');
    const novel = await db.createNovel({ userId: 'local-user', title: 'External Vault' });
    const externalVault = mkdtempSync(path.join(tmpdir(), 'inkmarshal-external-vault-'));
    const sentinel = path.join(externalVault, 'keep.md');
    writeFileSync(sentinel, 'must survive');
    await setNovelVaultPath(novel.id, externalVault);
    const params = { params: Promise.resolve({ id: novel.id }) };

    await moveToTrash(new Request(`http://localhost/api/novels/${novel.id}`, { method: 'DELETE' }), params);
    const deleted = await deletePermanently(new Request(`http://localhost/api/trash/${novel.id}`, { method: 'DELETE' }), params);

    expect(deleted.status).toBe(200);
    expect(existsSync(sentinel)).toBe(true);
    rmSync(externalVault, { recursive: true, force: true });
  });
});
