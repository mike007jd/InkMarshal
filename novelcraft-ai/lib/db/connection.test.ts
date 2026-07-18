// D2 / 04-routes R5 — the defense-in-depth runtime guard in `getDb()` must be a
// hard wall against the web runtime, while staying inert under vitest and dev.
// We flip NODE_ENV/INKMARSHAL_RUNTIME and re-import the module fresh each time
// (vi.resetModules) so the guard sees the env we set.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_NODE_ENV = process.env.NODE_ENV;
const PREV_RUNTIME = process.env.INKMARSHAL_RUNTIME;
const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  // Isolate the real-DB cases (test/desktop runtimes) under a temp data dir so
  // they never touch the developer's home dir.
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-conntest-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

// `NODE_ENV` is typed as a read-only literal by Next's env typings; index the
// mutable record view so the test can flip it at runtime.
const env = process.env as Record<string, string | undefined>;

function setEnv(key: 'NODE_ENV' | 'INKMARSHAL_RUNTIME', value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

afterEach(() => {
  setEnv('NODE_ENV', PREV_NODE_ENV);
  setEnv('INKMARSHAL_RUNTIME', PREV_RUNTIME);
  vi.resetModules();
});

describe('getDb runtime guard (D2 / R5)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws in a production web runtime (no desktop flag)', async () => {
    setEnv('NODE_ENV', 'production');
    setEnv('INKMARSHAL_RUNTIME', undefined);
    const { getDb } = await import('@/lib/db/connection');
    expect(() => getDb()).toThrow(/local database is not available in the web runtime/);
  });

  it('does NOT throw the runtime guard under vitest (NODE_ENV=test)', async () => {
    setEnv('NODE_ENV', 'test');
    setEnv('INKMARSHAL_RUNTIME', undefined);
    const { getDb, closeDbForTest } = await import('@/lib/db/connection');
    // Should open a real DB (under the test INKMARSHAL_DATA_DIR) without the
    // guard firing. We only assert it did not throw the guard message.
    try {
      expect(() => getDb()).not.toThrow(/web runtime/);
    } finally {
      closeDbForTest();
    }
  });

  it('does not throw the guard for a production desktop runtime', async () => {
    setEnv('NODE_ENV', 'production');
    setEnv('INKMARSHAL_RUNTIME', 'desktop');
    const { getDb, closeDbForTest } = await import('@/lib/db/connection');
    try {
      expect(() => getDb()).not.toThrow(/web runtime/);
    } finally {
      closeDbForTest();
    }
  });
});
