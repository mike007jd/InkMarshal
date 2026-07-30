import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const fixtureDir = process.env.INKMARSHAL_IMPORT_FIXTURE_DIR?.trim();
const dataDir = process.env.INKMARSHAL_DATA_DIR?.trim();
const runMatrix = fixtureDir && dataDir ? describe : describe.skip;

runMatrix('opaque import size matrix', () => {
  beforeAll(() => {
    delete process.env.INKMARSHAL_RUNTIME;
    delete process.env.INKMARSHAL_DESKTOP_SESSION;
  });

  afterAll(async () => {
    const { closeDbForTest } = await import('@/lib/db/connection');
    closeDbForTest();
  });

  for (const sizeMiB of [2, 10, 25]) {
    for (const extension of ['txt', 'md', 'docx'] as const) {
      it(`round-trips ${sizeMiB} MiB ${extension.toUpperCase()} without prose in the action payload`, async () => {
        const { createHash } = await import('node:crypto');
        const { stageTestManuscript } = await import('@/lib/import/session-store');
        const { openImportSession } = await import('@/lib/import/session-open');
        const { confirmImportSession } = await import('@/lib/import/session-confirm');
        const { deleteNovelCascade, getChapters } = await import('@/lib/db');

        const basename = `${sizeMiB}MiB.${extension}`;
        const bytes = readFileSync(path.join(fixtureDir!, basename));
        expect(bytes.byteLength).toBe(sizeMiB * 1024 * 1024);
        const token = createHash('sha256').update(basename).digest('hex');
        stageTestManuscript({ token, basename, bytes });

        const opened = await openImportSession({ token, basename });
        expect(opened.chapters).toHaveLength(1);
        expect(JSON.stringify(opened).length).toBeLessThan(500_000);
        expect(opened.chapters[0]).not.toHaveProperty('content');

        const result = await confirmImportSession({
          sessionToken: opened.sessionToken,
          mode: 'new',
          novelTitle: `Size Matrix ${basename}`,
          chapters: opened.chapters.map(chapter => ({
            title: chapter.title,
            parts: chapter.parts,
          })),
        });
        try {
          const chapters = await getChapters(result.novelId);
          expect(chapters).toHaveLength(1);
          expect(chapters[0]!.content.length).toBeGreaterThan(
            sizeMiB * 1024 * 1024 - 8_192,
          );
          expect(chapters[0]!.processingStatus).toBe('complete');
        } finally {
          await deleteNovelCascade(result.novelId, 'local-user');
        }
      }, 120_000);
    }
  }
});
