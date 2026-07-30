#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const fixtureDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-import-fixtures-'));
const dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-import-matrix-data-'));
const env = {
  ...process.env,
  INKMARSHAL_DATA_DIR: dataDir,
  INKMARSHAL_IMPORT_FIXTURE_DIR: fixtureDir,
};

try {
  execFileSync(
    process.execPath,
    ['e2e/desktop-smoke/generate-import-size-fixtures.mjs', fixtureDir],
    { cwd: root, env, stdio: 'inherit' },
  );
  execFileSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'e2e/desktop-smoke/import-size-matrix.test.ts',
    ],
    { cwd: root, env, stdio: 'inherit' },
  );
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
}
