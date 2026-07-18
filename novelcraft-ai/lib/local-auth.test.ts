import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-local-auth-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('requireNovelOwner', () => {
  it('rejects novels that exist but belong to a different local user row', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { requireNovelOwner } = await import('@/lib/local-auth');
    const novel = await createNovel({
      userId: 'other-user',
      title: 'Not local-user owned',
    });
    try {
      const result = await requireNovelOwner(novel.id);
      expect(result).toBeInstanceOf(NextResponse);
      expect((result as NextResponse).status).toBe(404);
    } finally {
      await deleteNovelCascade(novel.id, 'other-user');
    }
  });
});
