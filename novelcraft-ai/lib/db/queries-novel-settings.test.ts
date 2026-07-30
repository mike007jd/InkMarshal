import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LOCAL_USER_ID } from '@/lib/local-user';
import type { NovelSettings } from '@/lib/db-types';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-novel-settings-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('novel settings patches', () => {
  it('settles stale knowledge extraction without reverting newer user settings', async () => {
    const {
      claimNovelKbExtraction,
      createNovel,
      getNovel,
      updateNovel,
      updateNovelKbExtractionState,
    } = await import('@/lib/db');
    const kbExtractionId = '00000000-0000-4000-8000-000000000020';
    const novel = await createNovel({
      userId: LOCAL_USER_ID,
      title: 'Concurrent settings',
    });
    await updateNovel(novel.id, {
      settings: {
        creativity: 'balanced',
        importMeta: {
          source: 'md',
          importedAt: '2026-07-30T00:00:00.000Z',
          originalFilename: 'draft.md',
          detectedChapters: 3,
          kbExtraction: 'pending',
          kbExtractionId,
        },
      },
    });

    await updateNovel(novel.id, {
      settings: {
        creativity: 'wild',
        dailyWordGoal: 4321,
        importMeta: {
          source: 'md',
          importedAt: '2026-07-30T00:00:00.000Z',
          originalFilename: 'draft.md',
          detectedChapters: 3,
          kbExtraction: 'pending',
          kbExtractionId,
        },
      },
    });

    const claim = claimNovelKbExtraction(
      novel.id,
      kbExtractionId,
      90_000,
    );
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('claim failed');
    expect(updateNovelKbExtractionState(
      novel.id,
      kbExtractionId,
      claim.attemptId,
      'done',
    )).toBe(true);

    expect((await getNovel(novel.id))?.settings).toEqual({
      creativity: 'wild',
      dailyWordGoal: 4321,
      importMeta: {
        source: 'md',
        importedAt: '2026-07-30T00:00:00.000Z',
        originalFilename: 'draft.md',
        detectedChapters: 3,
        kbExtraction: 'done',
        kbExtractionId,
      },
    });
  });

  it('does not let an older extraction settle a newer import generation', async () => {
    const {
      claimNovelKbExtraction,
      createNovel,
      getNovel,
      updateNovel,
      updateNovelKbExtractionState,
    } = await import('@/lib/db');
    const oldId = '00000000-0000-4000-8000-000000000021';
    const newId = '00000000-0000-4000-8000-000000000022';
    const novel = await createNovel({
      userId: LOCAL_USER_ID,
      title: 'Superseded extraction',
    });
    await updateNovel(novel.id, {
      settings: {
        importMeta: {
          source: 'md',
          importedAt: '2026-07-30T00:00:30.000Z',
          originalFilename: 'old.md',
          detectedChapters: 2,
          kbExtraction: 'pending',
          kbExtractionId: oldId,
        },
      },
    });
    const oldClaim = claimNovelKbExtraction(novel.id, oldId, 90_000);
    expect(oldClaim.status).toBe('claimed');
    if (oldClaim.status !== 'claimed') throw new Error('old claim failed');
    await updateNovel(novel.id, {
      settings: {
        creativity: 'wild',
        importMeta: {
          source: 'docx',
          importedAt: '2026-07-30T00:01:00.000Z',
          originalFilename: 'new.docx',
          detectedChapters: 7,
          kbExtraction: 'pending',
          kbExtractionId: newId,
        },
      },
    });

    expect(updateNovelKbExtractionState(
      novel.id,
      oldId,
      oldClaim.attemptId,
      'done',
    )).toBe(false);
    expect((await getNovel(novel.id))?.settings).toEqual({
      creativity: 'wild',
      importMeta: {
        source: 'docx',
        importedAt: '2026-07-30T00:01:00.000Z',
        originalFilename: 'new.docx',
        detectedChapters: 7,
        kbExtraction: 'pending',
        kbExtractionId: newId,
      },
    });
  });

  it('can compose the generation-fenced state patch inside a wider transaction', async () => {
    const {
      claimNovelKbExtraction,
      createNovel,
      getNovel,
      updateNovel,
      updateNovelKbExtractionState,
    } = await import('@/lib/db');
    const { getDb } = await import('@/lib/db/connection');
    const kbExtractionId = '00000000-0000-4000-8000-000000000023';
    const novel = await createNovel({
      userId: LOCAL_USER_ID,
      title: 'Nested transaction',
    });
    await updateNovel(novel.id, {
      settings: {
        importMeta: {
          source: 'txt',
          importedAt: '2026-07-30T00:02:00.000Z',
          originalFilename: 'nested.txt',
          detectedChapters: 1,
          kbExtraction: 'pending',
          kbExtractionId,
        },
      },
    });

    const claim = claimNovelKbExtraction(novel.id, kbExtractionId, 90_000);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('claim failed');
    const settle = getDb().transaction(() =>
      updateNovelKbExtractionState(
        novel.id,
        kbExtractionId,
        claim.attemptId,
        'done',
      )
    );
    expect(settle()).toBe(true);
    expect((await getNovel(novel.id))?.settings?.importMeta?.kbExtraction)
      .toBe('done');
  });

  it('leases one attempt per generation and fences an expired owner', async () => {
    const {
      claimNovelKbExtraction,
      createNovel,
      renewNovelKbExtractionClaim,
      updateNovel,
      updateNovelKbExtractionState,
    } = await import('@/lib/db');
    const kbExtractionId = '00000000-0000-4000-8000-000000000024';
    const novel = await createNovel({
      userId: LOCAL_USER_ID,
      title: 'Attempt lease',
    });
    await updateNovel(novel.id, {
      settings: {
        importMeta: {
          source: 'txt',
          importedAt: '2026-07-30T00:04:00.000Z',
          originalFilename: 'lease.txt',
          detectedChapters: 1,
          kbExtraction: 'pending',
          kbExtractionId,
        },
      },
    });

    const first = claimNovelKbExtraction(novel.id, kbExtractionId, 100, 1_000);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') throw new Error('first claim failed');
    expect(claimNovelKbExtraction(novel.id, kbExtractionId, 100, 1_050))
      .toEqual({ status: 'in_progress' });
    expect(renewNovelKbExtractionClaim(
      novel.id,
      kbExtractionId,
      first.attemptId,
      100,
      1_075,
    )).toBe(true);
    expect(claimNovelKbExtraction(novel.id, kbExtractionId, 100, 1_150))
      .toEqual({ status: 'in_progress' });
    expect(renewNovelKbExtractionClaim(
      novel.id,
      kbExtractionId,
      first.attemptId,
      100,
      1_176,
    )).toBe(false);
    expect(updateNovelKbExtractionState(
      novel.id,
      kbExtractionId,
      first.attemptId,
      'done',
      1_176,
    )).toBe(false);

    const recovered = claimNovelKbExtraction(
      novel.id,
      kbExtractionId,
      100,
      1_176,
    );
    expect(recovered.status).toBe('claimed');
    if (recovered.status !== 'claimed') throw new Error('recovery claim failed');
    expect(recovered.attemptId).not.toBe(first.attemptId);
    expect(updateNovelKbExtractionState(
      novel.id,
      kbExtractionId,
      first.attemptId,
      'done',
      1_200,
    )).toBe(false);
    expect(updateNovelKbExtractionState(
      novel.id,
      kbExtractionId,
      recovered.attemptId,
      'done',
      1_200,
    )).toBe(true);
    expect(claimNovelKbExtraction(novel.id, kbExtractionId, 100, 1_200))
      .toEqual({ status: 'completed' });
  });

  it('does not create import metadata on a novel that has none', async () => {
    const {
      createNovel,
      getNovel,
      updateNovel,
      updateNovelKbExtractionState,
    } = await import('@/lib/db');
    const novel = await createNovel({
      userId: LOCAL_USER_ID,
      title: 'No import metadata',
    });
    await updateNovel(novel.id, {
      settings: { creativity: 'conservative' },
    });

    expect(updateNovelKbExtractionState(
      novel.id,
      '00000000-0000-4000-8000-000000000025',
      '00000000-0000-4000-8000-000000000125',
      'failed',
    )).toBe(false);

    expect((await getNovel(novel.id))?.settings).toEqual({
      creativity: 'conservative',
    });
  });

  it('strips internal extraction metadata from structurally wider settings patches', async () => {
    const {
      createNovel,
      getNovel,
      patchNovelSettings,
      updateNovel,
    } = await import('@/lib/db');
    const kbExtractionId = '00000000-0000-4000-8000-000000000026';
    const novel = await createNovel({
      userId: LOCAL_USER_ID,
      title: 'Runtime settings boundary',
    });
    await updateNovel(novel.id, {
      settings: {
        importMeta: {
          source: 'txt',
          importedAt: '2026-07-30T00:06:00.000Z',
          originalFilename: 'real.txt',
          detectedChapters: 1,
          kbExtraction: 'done',
          kbExtractionId,
          kbExtractionCompletedSlots: ['chunk:0'],
        },
      },
    });

    patchNovelSettings(novel.id, {
      creativity: 'wild',
      importMeta: {
        source: 'txt',
        importedAt: '2000-01-01T00:00:00.000Z',
        originalFilename: 'stale.txt',
        detectedChapters: 0,
        kbExtraction: 'running',
        kbExtractionId: '00000000-0000-4000-8000-000000000099',
        kbExtractionCompletedSlots: [],
      },
    } as Parameters<typeof patchNovelSettings>[1] & {
      importMeta: NovelSettings['importMeta'];
    }, ['importMeta'] as unknown as Parameters<typeof patchNovelSettings>[2]);

    expect((await getNovel(novel.id))?.settings).toEqual({
      creativity: 'wild',
      importMeta: {
        source: 'txt',
        importedAt: '2026-07-30T00:06:00.000Z',
        originalFilename: 'real.txt',
        detectedChapters: 1,
        kbExtraction: 'done',
        kbExtractionId,
        kbExtractionCompletedSlots: ['chunk:0'],
      },
    });
  });
});
