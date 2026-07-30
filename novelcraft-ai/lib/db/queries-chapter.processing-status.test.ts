import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { closeDbForTest } from '@/lib/db/connection';
import { createNovel } from '@/lib/db';
import {
  getChapter,
  updateChapterMeta,
  upsertChapter,
} from '@/lib/db/queries-chapter';

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  closeDbForTest();
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-chapter-status-'));
  process.env.INKMARSHAL_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDbForTest();
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('chapter processing_status queries', () => {
  it('defaults manual upserts to complete and AI upserts to content_saved until meta commits', async () => {
    const novel = await createNovel({ userId: 'local-user', title: 'Lifecycle' });

    const manual = await upsertChapter(novel.id, 1, 'Manual', 'manual imported prose here');
    expect(manual.processingStatus).toBe('complete');

    const ai = await upsertChapter(
      novel.id,
      2,
      'AI',
      'generated prose that still needs metadata',
      { processingStatus: 'content_saved' },
    );
    expect(ai.processingStatus).toBe('content_saved');
    expect(ai.summary).toBe('');

    await updateChapterMeta(novel.id, 2, {
      summary: 'done',
      keyFacts: null,
      qualityIssues: null,
      generationMeta: {
        targetWords: 800,
        actualWords: 6,
        attempts: 1,
        modelId: 'm',
        generatedAt: new Date().toISOString(),
      },
      processingStatus: 'complete',
    });

    const completed = await getChapter(novel.id, 2);
    expect(completed?.processingStatus).toBe('complete');
    expect(completed?.summary).toBe('done');
    expect(completed?.content).toBe('generated prose that still needs metadata');
  });
});
