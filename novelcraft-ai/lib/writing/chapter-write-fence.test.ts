import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeDbForTest } from '@/lib/db/connection';
import {
  acquireWritingLock,
  createNovel,
  getChapter,
  releaseWritingLock,
  updateChapterContent,
  updateChapterMeta,
  upsertChapter,
} from '@/lib/db';
import { ChapterWriteFenceError } from '@/lib/db/queries-chapter';

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  closeDbForTest();
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-chapter-fence-'));
  process.env.INKMARSHAL_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDbForTest();
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('token-fenced chapter persistence', () => {
  it('rejects a late save after the writing lease is replaced', async () => {
    const novel = await createNovel({ userId: 'local-user', title: 'Fenced Writer' });
    const first = await acquireWritingLock(novel.id, 300);
    expect(first).not.toBeNull();

    const created = await upsertChapter(
      novel.id,
      1,
      'One',
      'first draft from the original writer',
      {
        processingStatus: 'content_saved',
        writingLockToken: first!.token,
      },
    );
    expect(created.version).toBe(0);

    // Simulate lease expiry + replacement by another writer.
    await releaseWritingLock(novel.id, first!.token);
    const second = await acquireWritingLock(novel.id, 300);
    expect(second).not.toBeNull();
    expect(second!.token).not.toBe(first!.token);

    await expect(
      upsertChapter(
        novel.id,
        1,
        'One',
        'late overwrite from the expired writer',
        {
          processingStatus: 'content_saved',
          writingLockToken: first!.token,
          expectedVersion: created.version,
        },
      ),
    ).rejects.toBeInstanceOf(ChapterWriteFenceError);

    const chapter = await getChapter(novel.id, 1);
    expect(chapter).toMatchObject({
      content: 'first draft from the original writer',
      version: 0,
    });

    // The new lease holder can still save with the correct version fence.
    const replaced = await upsertChapter(
      novel.id,
      1,
      'One',
      'replacement from the new writer',
      {
        processingStatus: 'content_saved',
        writingLockToken: second!.token,
        expectedVersion: 0,
      },
    );
    expect(replaced).toMatchObject({
      content: 'replacement from the new writer',
      version: 1,
    });

    await releaseWritingLock(novel.id, second!.token);
  });

  it('rejects stale AI metadata after a user edit advances the content version', async () => {
    const novel = await createNovel({ userId: 'local-user', title: 'Version Fence' });
    const lease = await acquireWritingLock(novel.id, 300);
    expect(lease).not.toBeNull();

    const saved = await upsertChapter(
      novel.id,
      1,
      'One',
      'AI draft body that still needs metadata',
      {
        processingStatus: 'content_saved',
        writingLockToken: lease!.token,
      },
    );
    expect(saved).toMatchObject({ version: 0, processingStatus: 'content_saved' });

    // User edits between content save and AI metadata finalization.
    const edited = await updateChapterContent(
      novel.id,
      1,
      'User-edited body that must keep its own metadata',
      saved.version,
    );
    expect(edited).toEqual({ conflict: false, version: 1 });

    await expect(
      updateChapterMeta(
        novel.id,
        1,
        {
          summary: 'stale AI summary',
          keyFacts: {
            characters: ['ghost'],
            locations: [],
            items: [],
            plotMoves: [],
          },
          qualityIssues: [{ type: 'other', severity: 'minor', description: 'stale' }],
          generationMeta: {
            attempts: 1,
            actualWords: 8,
            targetWords: 1000,
            modelId: 'stale-model',
            generatedAt: '2026-07-30T00:00:00.000Z',
          },
          processingStatus: 'complete',
        },
        {
          writingLockToken: lease!.token,
          expectedVersion: saved.version,
        },
      ),
    ).rejects.toBeInstanceOf(ChapterWriteFenceError);

    const chapter = await getChapter(novel.id, 1);
    expect(chapter).toMatchObject({
      content: 'User-edited body that must keep its own metadata',
      version: 1,
      processingStatus: 'content_saved',
      summary: '',
      keyFacts: null,
      qualityIssues: null,
    });
    expect(chapter?.generationMeta?.modelId).not.toBe('stale-model');

    // Still-valid non-AI metadata callers (no lock fence) continue to work.
    await updateChapterMeta(novel.id, 1, { summary: 'manual summary refresh' });
    expect((await getChapter(novel.id, 1))?.summary).toBe('manual summary refresh');

    await releaseWritingLock(novel.id, lease!.token);
  });
});
