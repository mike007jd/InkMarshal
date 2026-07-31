import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDbForTest, getDb } from '@/lib/db/connection';
import { CURRENT_SCHEMA_VERSION } from '@/lib/db/schema';

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  closeDbForTest();
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-reset-route-'));
  process.env.INKMARSHAL_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDbForTest();
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/local-library/reset', () => {
  it('rebuilds an incompatible local library through the authenticated desktop route', async () => {
    const databasePath = path.join(dataDir, 'inkmarshal.db');
    const incompatible = new Database(databasePath);
    incompatible.exec('CREATE TABLE abandoned_dev_shape (value TEXT)');
    incompatible.close();
    const keepPath = path.join(dataDir, 'downloaded-model.gguf');
    writeFileSync(keepPath, 'keep');

    const { POST } = await import('@/app/api/local-library/reset/route');
    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(getDb().pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(existsSync(keepPath)).toBe(true);
  });
});
