// Phase 1 — app_settings KV round-trips through the real SQLite layer (schema
// 0011). Uses the same temp-DATA_DIR + real getDb() pattern as the other db
// tests; assertDbRuntimeAllowed is inert under vitest.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-appsettings-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function appSettings() {
  return import('@/lib/db/queries-app-settings');
}

afterEach(async () => {
  const { getAllAppSettings, deleteAppSetting } = await appSettings();
  for (const key of Object.keys(getAllAppSettings())) deleteAppSetting(key);
});

describe('queries-app-settings', () => {
  it('round-trips a value', async () => {
    const { setAppSetting, getAppSetting } = await appSettings();
    setAppSetting('inkmarshal_settings', '{"theme":"dark"}');
    expect(getAppSetting('inkmarshal_settings')).toBe('{"theme":"dark"}');
  });

  it('upserts on key conflict (last write wins)', async () => {
    const { setAppSetting, getAppSetting } = await appSettings();
    setAppSetting('locale', 'en');
    setAppSetting('locale', 'zh-CN');
    expect(getAppSetting('locale')).toBe('zh-CN');
  });

  it('returns null for a missing key', async () => {
    const { getAppSetting } = await appSettings();
    expect(getAppSetting('does-not-exist')).toBeNull();
  });

  it('getAllAppSettings returns every row as a flat record', async () => {
    const { setAppSetting, getAllAppSettings } = await appSettings();
    setAppSetting('a', '1');
    setAppSetting('b', '2');
    expect(getAllAppSettings()).toMatchObject({ a: '1', b: '2' });
  });

  it('deleteAppSetting removes the row', async () => {
    const { setAppSetting, deleteAppSetting, getAppSetting } = await appSettings();
    setAppSetting('a', '1');
    deleteAppSetting('a');
    expect(getAppSetting('a')).toBeNull();
  });
});
