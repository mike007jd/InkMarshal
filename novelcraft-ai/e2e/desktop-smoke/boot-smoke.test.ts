// E2E-01 — automated-unit desktop boot smoke.
//
// Exercises the boot invariants that need no GUI: the local SQLite store opens
// and initializes the current baseline on a cold start, and the desktop readiness probe answers with the
// session identity proof. The GUI / engine / WebDriver paths are gated on macOS
// CI (see smoke-matrix.ts).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
const PREV_RUNTIME = process.env.INKMARSHAL_RUNTIME;
const PREV_SESSION = process.env.INKMARSHAL_DESKTOP_SESSION;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-boot-smoke-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  if (PREV_RUNTIME === undefined) delete process.env.INKMARSHAL_RUNTIME;
  else process.env.INKMARSHAL_RUNTIME = PREV_RUNTIME;
  if (PREV_SESSION === undefined) delete process.env.INKMARSHAL_DESKTOP_SESSION;
  else process.env.INKMARSHAL_DESKTOP_SESSION = PREV_SESSION;
});

describe('desktop boot smoke (automated-unit)', () => {
  it('boot-sqlite: opens a fresh local DB at the current schema and round-trips a novel', async () => {
    const { getDb, closeDbForTest } = await import('@/lib/db/connection');
    const { createNovel, getNovel } = await import('@/lib/db');
    try {
      const db = getDb();
      expect(db.pragma('user_version', { simple: true })).toBe(1);
      // The DB file was actually created on disk under the data dir.
      expect(existsSync(path.join(tmpDir, 'inkmarshal.db'))).toBe(true);

      const created = await createNovel({ userId: '11111111-1111-1111-1111-111111111111', title: 'Boot', genre: 'f', targetWords: 1000 });
      const fetched = await getNovel(created.id);
      expect(fetched?.title).toBe('Boot');
    } finally {
      closeDbForTest();
    }
  });

  it('health-probe: returns the session identity proof only in the desktop runtime', async () => {
    const { GET } = await import('@/app/api/health/route');
    const { createHash } = await import('node:crypto');

    // Web runtime: ok + runtime, no session proof.
    delete process.env.INKMARSHAL_RUNTIME;
    delete process.env.INKMARSHAL_DESKTOP_SESSION;
    const webBody = await (GET() as Response).json();
    expect(webBody).toMatchObject({ ok: true, runtime: 'web' });
    expect(webBody.session).toBeUndefined();

    // Desktop runtime with a session token: publishes sha256(token) as the
    // readiness proof the native layer verifies before navigating the webview.
    process.env.INKMARSHAL_RUNTIME = 'desktop';
    process.env.INKMARSHAL_DESKTOP_SESSION = 'super-secret-token';
    const deskBody = await (GET() as Response).json();
    expect(deskBody.runtime).toBe('desktop');
    expect(deskBody.session).toBe(createHash('sha256').update('super-secret-token').digest('hex'));
    // One-way: the proof is not the raw token.
    expect(deskBody.session).not.toContain('super-secret-token');
  });
});
