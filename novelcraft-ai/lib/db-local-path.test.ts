import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  INKMARSHAL_APP_DIR,
  INKMARSHAL_HOME_DIR,
  LOCAL_DB_FILE,
  resolveInkmarshalAppDir,
  resolveInkmarshalHome,
  resolveLocalDbDir,
  resolveLocalDbPath,
} from '@/lib/db-local-path';

describe('local SQLite path contract', () => {
  it('honors INKMARSHAL_DATA_DIR as an explicit DB-dir override', () => {
    expect(resolveLocalDbDir({
      env: { INKMARSHAL_DATA_DIR: '~/InkData' },
      homeDir: '/Users/tester',
    })).toBe(path.resolve('/Users/tester/InkData'));
  });

  it('uses ~/.inkmarshal/app by default on every platform', () => {
    expect(resolveLocalDbDir({
      env: {},
      platform: 'darwin',
      homeDir: '/Users/tester',
    })).toBe(path.join('/Users/tester', INKMARSHAL_HOME_DIR, INKMARSHAL_APP_DIR));
    expect(resolveLocalDbDir({
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
    })).toBe(path.join('C:\\Users\\tester', INKMARSHAL_HOME_DIR, INKMARSHAL_APP_DIR));
    expect(resolveLocalDbDir({
      env: { XDG_DATA_HOME: '/home/tester/.data' },
      platform: 'linux',
      homeDir: '/home/tester',
    })).toBe(path.join('/home/tester', INKMARSHAL_HOME_DIR, INKMARSHAL_APP_DIR));
  });

  it('honors INKMARSHAL_HOME and expands a home-relative root override', () => {
    expect(resolveInkmarshalHome({
      env: { INKMARSHAL_HOME: '~/InkHome' },
      homeDir: '/Users/tester',
    })).toBe(path.resolve('/Users/tester/InkHome'));
    expect(resolveInkmarshalAppDir({
      env: { INKMARSHAL_HOME: '/Volumes/Fast/InkHome' },
      homeDir: '/Users/tester',
    })).toBe(path.join('/Volumes/Fast/InkHome', INKMARSHAL_APP_DIR));
  });

  it('resolves the database filename from the resolved directory', () => {
    expect(resolveLocalDbPath({
      env: { INKMARSHAL_DATA_DIR: '/tmp/inkmarshal' },
    })).toBe(path.join('/tmp/inkmarshal', LOCAL_DB_FILE));
  });
});
