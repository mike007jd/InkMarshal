#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { sql as currentSchemaSql } from '../lib/db/schema/0001_initial.ts';

const root = process.cwd();
const dataDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-full-novel-qa-'));
const exportDir = path.join(dataDir, 'exports');
const env = {
  ...process.env,
  INKMARSHAL_DATA_DIR: dataDir,
  FULL_NOVEL_QA_DATA_DIR: dataDir,
  FULL_NOVEL_QA_EXPORT_DIR: exportDir,
};

function run(command, args) {
  execFileSync(command, args, { cwd: root, env, stdio: 'inherit' });
}

function initializeCurrentDatabase() {
  const db = new Database(path.join(dataDir, 'inkmarshal.db'));
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.exec(currentSchemaSql);
    db.exec(
      'CREATE TABLE _schema_version (version INTEGER NOT NULL, description TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    db.prepare(
      'INSERT INTO _schema_version (version, description, applied_at) VALUES (1, ?, ?)',
    ).run('current_prelaunch_baseline', now);
    db.pragma('user_version = 1');
  });
  try {
    tx();
  } finally {
    db.close();
  }
}

try {
  initializeCurrentDatabase();
  run(process.execPath, ['scripts/seed-full-novel-qa-data.mjs', `--data-dir=${dataDir}`]);
  run(process.execPath, ['scripts/assert-full-novel-qa-data.mjs', `--data-dir=${dataDir}`]);
  run(process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'run',
    'scripts/full-novel-qa.test.ts',
  ]);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
