import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDbForTest, getDb } from '@/lib/db/connection';

const previousDataDir = process.env.INKMARSHAL_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  closeDbForTest();
  dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-clear-route-'));
  process.env.INKMARSHAL_DATA_DIR = dataDir;
});

afterEach(() => {
  closeDbForTest();
  if (previousDataDir === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/local-library/clear', () => {
  it('clears books while retaining durable app configuration', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO novels (id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('novel-1', 'local-user', now, now);
    db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
      .run('inkmarshal_connections_v1', '[{"id":"provider-1"}]', now);

    const { POST } = await import('@/app/api/local-library/clear/route');
    const response = await POST();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM novels').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('inkmarshal_connections_v1'))
      .toEqual({ value: '[{"id":"provider-1"}]' });
  });
});
