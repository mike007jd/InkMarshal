import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

import { LOCAL_USER_ID } from '@/lib/local-user';

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let tempDataDir: string;

beforeAll(() => {
  tempDataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-library-backup-'));
  process.env.INKMARSHAL_DATA_DIR = tempDataDir;
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(tempDataDir, { recursive: true, force: true });
});

async function modules() {
  return {
    db: await import('@/lib/db'),
    extract: await import('@/lib/backup/extract'),
    build: await import('@/lib/backup/build-package'),
    library: await import('@/lib/backup/build-library-package'),
    verify: await import('@/lib/backup/verify'),
    restore: await import('@/lib/backup/restore'),
  };
}

describe('full library backup', () => {
  it('contains every novel as a verified, independently restorable .inkmarshal package', async () => {
    const { db, extract, build, library, verify, restore } = await modules();
    const first = await db.createNovel({ userId: LOCAL_USER_ID, title: '同名作品' });
    const second = await db.createNovel({ userId: LOCAL_USER_ID, title: '同名作品' });
    await db.upsertChapter(first.id, 1, '第一章', '第一部小说正文。');
    await db.upsertChapter(second.id, 1, 'Chapter One', 'Second novel body.');

    const sourceNovels = [first, second];
    const items = await Promise.all(sourceNovels.map(async novel => {
      const bundle = await extract.extractBackupBundle(novel.id);
      const built = await build.buildBackupPackage(bundle);
      return { novel, backupBytes: built.bytes };
    }));
    const exportedAt = '2026-07-18T06:00:00.000Z';
    const builtLibrary = library.buildLibraryBackupPackage(items, exportedAt);
    const entries = unzipSync(builtLibrary.bytes);
    const manifest = JSON.parse(strFromU8(entries[library.LIBRARY_MANIFEST_PATH]));

    expect(manifest).toMatchObject({
      formatVersion: library.LIBRARY_BACKUP_FORMAT_VERSION,
      exportedAt,
      novelCount: 2,
    });
    expect(manifest.novels.map((novel: { id: string }) => novel.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(new Set(manifest.novels.map((novel: { path: string }) => novel.path)).size).toBe(2);

    const restoredIds: string[] = [];
    for (const novel of manifest.novels as Array<{ path: string }>) {
      expect(novel.path).toMatch(/^novels\/\d{4}-.*\.inkmarshal$/);
      const report = await verify.verifyBackupPackage(entries[novel.path]);
      expect(report.ok).toBe(true);
      expect(report.bundle).not.toBeNull();
      const restored = await restore.restoreBundleAsCopy(report.bundle!);
      restoredIds.push(restored.novelId);
      expect(restored.counts.chapters).toBe(1);
    }

    expect(new Set(restoredIds).size).toBe(2);
    expect((await db.getNovels(LOCAL_USER_ID)).length).toBe(4);
  });
});
