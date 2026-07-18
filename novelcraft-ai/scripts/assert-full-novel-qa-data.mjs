#!/usr/bin/env node

import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveInkmarshalAppDir } from './inkmarshal-local-paths.mjs';

const NOVEL_ID = 'qa-full-novel-scale';
const SERIES_TITLE = 'The Aurelian Cycle';
const DB_FILE = 'inkmarshal.db';
const REAL_DATA_DIR = resolveInkmarshalAppDir({ homeDir: homedir() });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function argValue(flag) {
  const inline = process.argv.find(a => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);

  const index = process.argv.indexOf(flag);
  const next = index === -1 ? null : process.argv[index + 1];
  return next && !next.startsWith('--') ? next : null;
}

function resolveHomePath(raw) {
  if (raw === '~' || raw.startsWith('~/')) return path.resolve(homedir() + raw.slice(1));
  return path.resolve(raw);
}

function resolveDataDir() {
  const raw = argValue('--data-dir') || process.env.FULL_NOVEL_QA_DATA_DIR || process.env.INKMARSHAL_DATA_DIR;
  if (!raw?.trim()) {
    throw new Error('Missing data dir. Pass --data-dir=/tmp/inkmarshal-full-novel or set FULL_NOVEL_QA_DATA_DIR.');
  }
  return resolveHomePath(raw);
}

function isInsideOrEqual(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNotRealDataDir(dataDir) {
  if (!isInsideOrEqual(REAL_DATA_DIR, dataDir) || process.argv.includes('--allow-real-data-dir')) return;
  throw new Error('Refusing to read the real InkMarshal data dir without --allow-real-data-dir. Use an isolated copied QA DB for this gate.');
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

function scalar(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
}

function assert(condition, message, detail) {
  if (!condition) {
    const suffix = detail === undefined ? '' : `: ${JSON.stringify(detail)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function assertNoUnexpectedModels(dataDir) {
  const files = walkFiles(path.join(dataDir, 'models'));
  const unexpected = files.filter(file => {
    const name = path.basename(file);
    return !['inkmarshal-meta.db', 'inkmarshal-meta.db-wal', 'inkmarshal-meta.db-shm'].includes(name);
  });
  assert(unexpected.length === 0, 'Unexpected local model files found', unexpected.map(file => path.relative(dataDir, file)));
  return files.length - unexpected.length;
}

function main() {
  const dataDir = resolveDataDir();
  assertNotRealDataDir(dataDir);
  const dbPath = path.join(dataDir, DB_FILE);
  assert(existsSync(dbPath), 'Database file does not exist', dbPath);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const schemaVersion = scalar(db, 'SELECT version FROM _schema_version ORDER BY version DESC LIMIT 1');
    assert(schemaVersion === 1, 'Expected baseline schema v1', { schemaVersion });

    const novel = db.prepare(
      'SELECT id, title, series_id, vault_version FROM novels WHERE id = ?',
    ).get(NOVEL_ID);
    assert(Boolean(novel), 'Missing QA novel', NOVEL_ID);
    assert(novel.title === 'The Aurelian Archive', 'Unexpected QA novel title', novel.title);
    assert(novel.vault_version === 1 || novel.vault_version === 2, 'Unexpected vault version', novel.vault_version);

    const series = db.prepare('SELECT id, title FROM series WHERE id = ?').get(novel.series_id);
    assert(Boolean(series), 'Missing QA series', novel.series_id);
    assert(UUID_RE.test(series.id), 'Series id must be UUID', series.id);
    assert(series.title === SERIES_TITLE, 'Unexpected series title', series.title);

    const chapters = scalar(db, 'SELECT COUNT(*) FROM chapters WHERE novel_id = ?', NOVEL_ID);
    const words = scalar(db, 'SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE novel_id = ?', NOVEL_ID);
    assert(chapters === 80, 'Expected 80 chapters', chapters);
    assert(words === 106690, 'Expected full-novel word count', words);

    const knowledge = scalar(db, 'SELECT COUNT(*) FROM knowledge_entries WHERE novel_id = ?', NOVEL_ID);
    const sharedKnowledge = scalar(
      db,
      'SELECT COUNT(*) FROM knowledge_entries WHERE novel_id = ? AND series_id = ?',
      NOVEL_ID,
      series.id,
    );
    assert(knowledge === 86, 'Expected 86 knowledge entries', knowledge);
    assert(sharedKnowledge === 1, 'Expected one shared series knowledge entry', sharedKnowledge);

    const nonUuidKnowledge = db.prepare(
      "SELECT id FROM knowledge_entries WHERE novel_id = ? AND id NOT GLOB '????????-????-????-????-????????????'",
    ).all(NOVEL_ID);
    assert(nonUuidKnowledge.length === 0, 'Knowledge ids must be UUID-shaped', nonUuidKnowledge);

    const duplicateKnowledge = db.prepare(
      `SELECT type, title, COUNT(*) AS n
         FROM knowledge_entries
        WHERE novel_id = ?
        GROUP BY type, title
       HAVING n > 1`,
    ).all(NOVEL_ID);
    assert(duplicateKnowledge.length === 0, 'Duplicate knowledge type/title rows found', duplicateKnowledge);

    const sharedProjection = scalar(
      db,
      "SELECT COUNT(*) FROM knowledge_index WHERE novel_id = ? AND path LIKE 'shared/%'",
      NOVEL_ID,
    );
    assert(sharedProjection === 0 || sharedProjection === 1, 'Unexpected shared projection count', sharedProjection);

    const aiRuns = scalar(db, 'SELECT COUNT(*) FROM ai_runs WHERE novel_id = ?', NOVEL_ID);
    const acceptedWords = scalar(db, 'SELECT COALESCE(SUM(accepted_words), 0) FROM ai_runs WHERE novel_id = ?', NOVEL_ID);
    const totalTokens = scalar(db, 'SELECT COALESCE(SUM(total_tokens), 0) FROM ai_runs WHERE novel_id = ?', NOVEL_ID);
    assert(aiRuns === 80, 'Expected 80 AI usage rows', aiRuns);
    assert(acceptedWords === 106690, 'Expected accepted words to match manuscript word count', acceptedWords);
    assert(totalTokens === 366880, 'Expected deterministic token total', totalTokens);

    const vaultRoot = path.join(dataDir, 'vaults', NOVEL_ID);
    assert(existsSync(vaultRoot), 'Expected QA vault root to exist', vaultRoot);
    const vaultMarkdownFiles = walkFiles(vaultRoot).filter(file => file.endsWith('.md')).length;
    if (novel.vault_version === 2) {
      assert(vaultMarkdownFiles >= 86, 'Migrated vault should contain at least 86 Markdown files', vaultMarkdownFiles);
    }

    const modelMetadataFiles = assertNoUnexpectedModels(dataDir);
    const summary = {
      ok: true,
      dbPath,
      schemaVersion,
      vaultVersion: novel.vault_version,
      chapters,
      words,
      knowledge,
      sharedKnowledge,
      sharedProjection,
      aiRuns,
      acceptedWords,
      totalTokens,
      vaultMarkdownFiles,
      modelMetadataFiles,
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error((error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
