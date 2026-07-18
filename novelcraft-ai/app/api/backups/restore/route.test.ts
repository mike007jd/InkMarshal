import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-backup-routes-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('backup UI routes', () => {
  it('keeps export generation within the native restore picker limit', () => {
    const exportRoute = readFileSync(path.join(process.cwd(), 'app/api/novels/[id]/backup/route.ts'), 'utf8');
    const restoreRoute = readFileSync(path.join(process.cwd(), 'app/api/backups/restore/route.ts'), 'utf8');
    const native = readFileSync(path.join(process.cwd(), 'src-tauri/src/lib.rs'), 'utf8');
    expect(exportRoute).toContain('128 * 1024 * 1024');
    expect(restoreRoute).toContain('128 * 1024 * 1024');
    expect(native).toContain('const MAX_IMPORT_FILE_BYTES: u64 = 128 * 1024 * 1024;');
  });

  it('exports a verified package and restores it only as a separate copy', async () => {
    const db = await import('@/lib/db');
    const { verifyBackupPackage } = await import('@/lib/backup/verify');
    const { POST: exportBackup } = await import('@/app/api/novels/[id]/backup/route');
    const { POST: restoreBackup } = await import('./route');
    const novel = await db.createNovel({ userId: 'local-user', title: 'Route Backup' });
    await db.upsertChapter(novel.id, 1, 'Opening', 'The backed-up chapter.');

    const exported = await exportBackup(
      new Request(`http://localhost/api/novels/${novel.id}/backup`, { method: 'POST' }),
      { params: Promise.resolve({ id: novel.id }) },
    );
    const bytes = new Uint8Array(await exported.arrayBuffer());
    expect(exported.status).toBe(200);
    expect(exported.headers.get('Content-Disposition')).toContain('.inkmarshal');
    expect((await verifyBackupPackage(bytes)).ok).toBe(true);

    const restoredResponse = await restoreBackup(new Request('http://localhost/api/backups/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.inkmarshal.backup+zip' },
      body: bytes,
    }));
    const restored = await restoredResponse.json() as { novelId: string; verified: boolean };
    expect(restoredResponse.status).toBe(200);
    expect(restored.verified).toBe(true);
    expect(restored.novelId).not.toBe(novel.id);
    expect((await db.getNovel(restored.novelId))?.title).toBe('Route Backup');
    expect((await db.getChapter(restored.novelId, 1))?.content).toBe('The backed-up chapter.');
    expect((await db.getNovel(novel.id))?.title).toBe('Route Backup');
  });

  it('refuses invalid bytes without creating a novel', async () => {
    const db = await import('@/lib/db');
    const { POST: restoreBackup } = await import('./route');
    const before = await db.getNovels('local-user');
    const response = await restoreBackup(new Request('http://localhost/api/backups/restore', {
      method: 'POST',
      body: new TextEncoder().encode('not a backup'),
    }));
    expect(response.status).toBe(422);
    expect(await db.getNovels('local-user')).toHaveLength(before.length);
  });
});
