#!/usr/bin/env node

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveInkmarshalAppDir } from './inkmarshal-local-paths.mjs';

const DB_FILE = 'inkmarshal.db';
const LOCAL_USER_ID = 'local-user';
const LOCAL_USER_EMAIL = 'local@inkmarshal.local';
const NOVEL_ID = 'qa-full-novel-scale';
const SERIES_ID = stableUuid('series:aurelian-cycle');
const LEGACY_SERIES_IDS = ['qa-aurelian-cycle'];
const CHAPTER_COUNT = 80;
const TARGET_WORDS = 120000;
const REAL_DATA_DIR = resolveInkmarshalAppDir({ homeDir: homedir() });
const CONFIRM_REAL_DATA_FLAG = '--confirm-real-data-dir';

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
  const raw = argValue('--data-dir') || process.env.INKMARSHAL_DATA_DIR;
  if (!raw?.trim()) {
    console.error('Missing data dir. Set INKMARSHAL_DATA_DIR or pass --data-dir=/tmp/inkmarshal-full-novel');
    process.exit(2);
  }
  return resolveHomePath(raw);
}

function isInsideOrEqual(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasRealDataConfirmation() {
  return process.argv.includes(CONFIRM_REAL_DATA_FLAG) || process.env.INKMARSHAL_CONFIRM_REAL_DATA_DIR === '1';
}

function assertSafeDataDir(dataDir) {
  if (!isInsideOrEqual(REAL_DATA_DIR, dataDir) || hasRealDataConfirmation()) return;

  console.error([
    `Refusing to seed the real InkMarshal data directory without ${CONFIRM_REAL_DATA_FLAG}.`,
    `Data dir: ${dataDir}`,
    'Use an isolated --data-dir for automation, or pass the confirmation flag only after explicit approval to reset local InkMarshal QA data.',
  ].join('\n'));
  process.exit(4);
}

function iso(daysAgo = 0, hoursAgo = 0) {
  return new Date(Date.now() - daysAgo * 86_400_000 - hoursAgo * 3_600_000).toISOString();
}

function id(prefix, n) {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

function stableUuid(seed) {
  const bytes = createHash('sha256').update(`inkmarshal-full-novel-qa:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function knowledgeId(type, n) {
  return stableUuid(`knowledge:${type}:${n}`);
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function chapterTitle(n) {
  const titles = [
    'The Salt Observatory',
    'A Treaty Written in Rain',
    'Maps Beneath the Harbor',
    'The Parliament of Glass',
    'A Lantern for the Missing',
    'The Archive Learns to Sing',
    'Winter Terms',
    'The Bridge of Unsaid Names',
  ];
  return `${String(n).padStart(2, '0')} - ${titles[(n - 1) % titles.length]}`;
}

function chapterContent(n) {
  const title = chapterTitle(n);
  const arc = n <= 20 ? 'discovery' : n <= 40 ? 'fracture' : n <= 60 ? 'siege' : 'reconciliation';
  const beats = [
    `Mara Vale records the morning tide in the observatory ledger and notices that chapter ${n} of the city calendar has been altered.`,
    `Ilyan Cross argues that the alteration is not sabotage but a message from the buried archive under Aurelian Harbor.`,
    `Sister Orra tests the claim against three witness accounts, one civic map, and the private oath that holds the Lantern Guild together.`,
    `The scene advances the ${arc} arc by forcing the crew to choose between public safety and the truth that would shame their founders.`,
    `A quiet image closes the movement: brass bells, wet stone, lamp smoke, and the sound of distant engines turning below the quay.`,
  ];
  const paragraphs = [];
  for (let i = 0; i < 13; i += 1) {
    paragraphs.push(
      `${beats[i % beats.length]} The prose stays intentionally sanitized and deterministic for QA, but it carries continuity markers: Mara keeps the black compass, Ilyan hides the cracked seal, Orra preserves the witness ribbon, and the harbor clock loses one minute each night. ${title} ties back to the prior chapter while leaving a concrete decision for the next one. The paragraph is long enough to exercise reading, search, export, pagination, autosave, summaries, and large-project rendering without using real or personal data.`,
    );
  }
  return paragraphs.join('\n\n');
}

function chapterSummary(n) {
  return `Chapter ${n} advances the ${n <= 20 ? 'setup' : n <= 40 ? 'midpoint fracture' : n <= 60 ? 'city siege' : 'final repair'} arc, preserves the compass/seal/ribbon continuity chain, and ends with a decision that feeds chapter ${Math.min(n + 1, CHAPTER_COUNT)}.`;
}

function checkSchema(db) {
  const version = db.prepare('SELECT version FROM _schema_version ORDER BY version DESC LIMIT 1').get()?.version;
  if (version !== 1) {
    console.error(`Expected InkMarshal baseline schema v1, found ${version ?? 'none'}. Start the app once with this INKMARSHAL_DATA_DIR before seeding.`);
    process.exit(3);
  }
}

function deletePriorSeed(db) {
  db.prepare(`
    DELETE FROM knowledge_relations
    WHERE source_id IN (SELECT id FROM knowledge_entries WHERE novel_id = ?)
       OR target_id IN (SELECT id FROM knowledge_entries WHERE novel_id = ?)
  `).run(NOVEL_ID, NOVEL_ID);
  db.prepare('DELETE FROM knowledge_embeddings WHERE novel_id = ?').run(NOVEL_ID);
  db.prepare('DELETE FROM knowledge_index WHERE novel_id = ?').run(NOVEL_ID);
  db.prepare('DELETE FROM knowledge_entries WHERE novel_id = ?').run(NOVEL_ID);
  db.prepare('DELETE FROM activity_events WHERE novel_id = ?').run(NOVEL_ID);
  db.prepare("DELETE FROM ai_runs WHERE id LIKE 'airun-%'").run();
  db.prepare('DELETE FROM messages WHERE novel_id = ?').run(NOVEL_ID);
  db.prepare('DELETE FROM conversations WHERE novel_id = ?').run(NOVEL_ID);
  db.prepare('DELETE FROM chapter_chat_history WHERE novel_id = ?').run(NOVEL_ID);
  db.prepare('DELETE FROM writing_jobs WHERE novel_id = ?').run(NOVEL_ID);
  db.prepare('DELETE FROM chapters WHERE novel_id = ?').run(NOVEL_ID);
  for (const seriesId of [SERIES_ID, ...LEGACY_SERIES_IDS]) {
    db.prepare('UPDATE novels SET series_id = NULL WHERE series_id = ?').run(seriesId);
    db.prepare('DELETE FROM series WHERE id = ?').run(seriesId);
  }
  db.prepare('DELETE FROM novels WHERE id = ?').run(NOVEL_ID);
}

function prepareVaultRoot(dataDir) {
  const vaultPath = path.join(dataDir, 'vaults', NOVEL_ID);
  rmSync(vaultPath, { recursive: true, force: true });
  mkdirSync(vaultPath, { recursive: true });
  return vaultPath;
}

function insertKnowledge(db, now) {
  const entries = [];
  const push = (type, n, title, summary, data, sortOrder, tags = [], seriesId = null) => {
    entries.push({ id: knowledgeId(type, n), type, title, summary, data: JSON.stringify(data), sortOrder, tags: JSON.stringify(tags), seriesId });
  };

  for (let n = 1; n <= CHAPTER_COUNT; n += 1) {
    push('outline', n, chapterTitle(n), chapterSummary(n), {
      level: 'chapter',
      chapterNumber: n,
      synopsis: chapterSummary(n),
      keyEvents: [`Continuity marker ${n}`, `Decision ${n}`],
      characters: ['Mara Vale', 'Ilyan Cross', 'Sister Orra'],
      pov: n % 3 === 0 ? 'Orra close third' : n % 2 === 0 ? 'Ilyan close third' : 'Mara close third',
      status: 'drafted',
      wordCountTarget: Math.round(TARGET_WORDS / CHAPTER_COUNT),
      plotline: n <= 40 ? 'archive conspiracy' : 'harbor restoration',
      notes: 'QA sanitized outline entry.',
    }, n - 1, ['outline', 'qa']);
  }

  [
    ['character', 1, 'Mara Vale', 'Cartographer protagonist with the black compass.', { role: 'protagonist', aliases: ['Mara'], arc: 'from private guilt to public stewardship' }],
    ['character', 2, 'Ilyan Cross', 'Harbor engineer carrying the cracked civic seal.', { role: 'deuteragonist', aliases: ['Ilyan'], arc: 'from loyal silence to testimony' }],
    ['character', 3, 'Sister Orra', 'Archivist and witness keeper for the Lantern Guild.', { role: 'mentor', aliases: ['Orra'], arc: 'from custodian to reformer' }],
    ['world', 1, 'Aurelian Harbor', 'A rainbound city built over a buried archive engine.', {
      category: 'location',
      description: 'A rainbound city built over a buried archive engine.',
      details: {
        locations: 'observatory, quay, underarchive',
        rule: 'the clock loses one minute nightly',
      },
      crossBookState: {
        [NOVEL_ID]: { status: 'stable', relationsDelta: 'Single-book QA baseline.' },
      },
    }, SERIES_ID],
    ['timeline', 1, 'Harbor Clock Drift', 'The clock drift escalates from clue to civic emergency.', { startChapter: 1, payoffChapter: 74 }],
    ['style_reference', 1, 'Literary Continuity Style', 'Measured literary prose with concrete recurring objects.', { voice: 'close third, sensory, continuity-heavy' }],
  ].forEach((row, i) => push(row[0], 100 + i, row[2], row[3], row[4], 1000 + i, ['qa'], row[5] ?? null));

  const stmt = db.prepare(
    `INSERT INTO knowledge_entries
      (id, novel_id, series_id, type, title, summary, data, sort_order, tags, created_at, updated_at)
     VALUES (@id, @novelId, @seriesId, @type, @title, @summary, @data, @sortOrder, @tags, @createdAt, @updatedAt)`,
  );
  for (const entry of entries) {
    stmt.run({ ...entry, novelId: NOVEL_ID, createdAt: now, updatedAt: now });
  }
}

function insertChapters(db, now) {
  const stmt = db.prepare(
    `INSERT INTO chapters (
       id, novel_id, chapter_number, title, content, original_content, word_count, version,
       summary, key_facts, key_facts_v, quality_issues, quality_issues_v,
       generation_meta, generation_meta_v, snapshots, created_at
     ) VALUES (
       @id, @novelId, @chapterNumber, @title, @content, @originalContent, @wordCount, @version,
       @summary, @keyFacts, 1, @qualityIssues, 1, @generationMeta, 1, @snapshots, @createdAt
     )`,
  );
  for (let n = 1; n <= CHAPTER_COUNT; n += 1) {
    const content = chapterContent(n);
    const qualityIssues = n % 13 === 0
      ? [{ type: 'timeline', description: `Verify clock drift reference in chapter ${n}.`, severity: n % 26 === 0 ? 'major' : 'minor' }]
      : [];
    stmt.run({
      id: id('chapter', n),
      novelId: NOVEL_ID,
      chapterNumber: n,
      title: chapterTitle(n),
      content,
      originalContent: n % 10 === 0 ? content.replace('public stewardship', 'private repair') : null,
      wordCount: wordCount(content),
      version: 2,
      summary: chapterSummary(n),
      keyFacts: JSON.stringify({
        characters: ['Mara Vale', 'Ilyan Cross', 'Sister Orra'],
        locations: ['Aurelian Harbor'],
        items: ['black compass', 'cracked seal', 'witness ribbon'],
        plotMoves: [`Chapter ${n} decision recorded`],
      }),
      qualityIssues: JSON.stringify(qualityIssues),
      generationMeta: JSON.stringify({
        targetWords: Math.round(TARGET_WORDS / CHAPTER_COUNT),
        actualWords: wordCount(content),
        attempts: 1,
        modelId: 'qa-local-deterministic-prose',
        generatedAt: iso(6, CHAPTER_COUNT - n),
        ralphLoop: { revisionCount: n % 5 === 0 ? 1 : 0, finalScore: 0.91, fixedIssues: n % 5 === 0 ? 1 : 0 },
      }),
      snapshots: JSON.stringify([
        { id: id('snapshot', n), createdAt: Date.now() - n * 1000, label: 'QA baseline', content },
      ]),
      createdAt: iso(6, CHAPTER_COUNT - n),
    });
  }
}

function insertActivityAndUsage(db) {
  const activity = db.prepare(
    `INSERT INTO activity_events
      (id, novel_id, type, source, chapter_number, words_delta, day_key, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const aiRun = db.prepare(
    `INSERT INTO ai_runs
      (id, user_id, novel_id, chapter_number, operation, role, connection_kind, provider_id, model_id,
       input_tokens, output_tokens, total_tokens, first_token_ms, duration_ms, outcome, est_cost_usd,
       accepted, accepted_words, generated_words, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let n = 1; n <= CHAPTER_COUNT; n += 1) {
    const words = wordCount(chapterContent(n));
    const created = iso(Math.floor((CHAPTER_COUNT - n) / 10), CHAPTER_COUNT - n);
    const dayKey = created.slice(0, 10);
    activity.run(id('activity', n), NOVEL_ID, 'chapter_written', 'ai', n, words, dayKey, JSON.stringify({ qaSeed: true }), created);
    aiRun.run(
      id('airun', n), LOCAL_USER_ID, NOVEL_ID, n, 'chapter', 'draft', 'local', 'bundled-llama',
      'qa-local-deterministic-prose', 1800 + n * 4, 2300 + n * 8, 4100 + n * 12,
      220 + (n % 8) * 20, 42_000 + n * 250, 'success', 0, 1, words, words, created,
    );
  }
}

function main() {
  const dataDir = resolveDataDir();
  assertSafeDataDir(dataDir);
  const dbPath = path.join(dataDir, DB_FILE);
  if (!existsSync(dbPath)) {
    console.error(`Database does not exist at ${dbPath}. Start the app once with this data dir so the baseline schema is created.`);
    process.exit(3);
  }
  mkdirSync(dataDir, { recursive: true });
  const vaultPath = prepareVaultRoot(dataDir);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  checkSchema(db);
  const now = iso();
  const tx = db.transaction(() => {
    deletePriorSeed(db);
    db.prepare('INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)').run(LOCAL_USER_ID, LOCAL_USER_EMAIL, now, now);
    db.prepare('INSERT INTO series (id, user_id, title, description, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      SERIES_ID, LOCAL_USER_ID, 'The Aurelian Cycle', 'QA series container for shared-world full-novel coverage.', JSON.stringify({ qaSeed: true }), now, now,
    );
    db.prepare(
      `INSERT INTO novels (
        id, user_id, series_id, title, genre, target_words, stage, progress,
        story_summary, character_summary, arc_summary, interview_state, interview_state_v,
        writing_lock_token, writing_lock_expires_at, unification_report, unification_report_v,
        settings, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, 1, ?, ?, ?)`,
    ).run(
      NOVEL_ID,
      LOCAL_USER_ID,
      SERIES_ID,
      'The Aurelian Archive',
      'Literary speculative mystery',
      TARGET_WORDS,
      'whole_book_unification',
      92,
      'A cartographer, an engineer, and an archivist uncover the buried civic engine beneath Aurelian Harbor and repair the city without erasing its history.',
      'Mara Vale, Ilyan Cross, and Sister Orra carry the core continuity chain across eighty chapters.',
      'Discovery, fracture, siege, and reconciliation arcs are all drafted and ready for whole-book polish.',
      JSON.stringify({ qaSeed: true, status: 'proposal_approved', acceptedAt: now }),
      JSON.stringify({
        summary: 'QA unification pass found finite continuity edits for clock drift, object naming, and chapter-level pacing.',
        generatedAt: now,
        modelId: 'qa-local-deterministic-unifier',
        edits: [
          { id: 'u-001', chapterNumber: 12, original: 'silent clock', replacement: 'clock losing one minute', rationale: 'Motif consistency.', severity: 'minor' },
          { id: 'u-002', chapterNumber: 48, original: 'silver compass', replacement: 'black compass', rationale: 'Object continuity.', severity: 'major' },
          { id: 'u-003', chapterNumber: 76, original: 'private repair', replacement: 'public stewardship', rationale: 'Arc payoff.', severity: 'major', applied: true, appliedAt: now },
        ],
      }),
      JSON.stringify({
        creativity: 'balanced',
        deadline: iso(-45).slice(0, 10),
        dailyWordGoal: 1800,
        weeklyWordGoal: 9000,
        workStatus: 'line_revision',
        backup: { autoEnabled: true, intervalHours: 24, keepCopies: 7, lastManualAt: now },
        publishing: {
          metadata: { author: 'QA Author', subtitle: 'A Local-First Test Novel', language: 'en-NZ', copyrightYear: '2026' },
          frontMatter: {
            titlePage: { enabled: true }, copyrightPage: { enabled: true }, toc: { enabled: true },
            dedication: { enabled: true, body: 'For full-novel QA.' }, acknowledgements: { enabled: false }, authorBio: { enabled: true, body: 'Sanitized test author.' },
          },
          layout: { chapterStartStyle: 'newPage', trim: '6x9', marginsMm: 18, header: 'The Aurelian Archive', footer: '{page}' },
          activePreset: 'publication',
        },
      }),
      now,
      now,
    );
    insertKnowledge(db, now);
    insertChapters(db, now);
    insertActivityAndUsage(db);
    db.prepare(
      `INSERT INTO conversations (id, novel_id, user_id, topic, title, parent_message_id, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
    ).run('qa-conversation-continuity', NOVEL_ID, LOCAL_USER_ID, 'chapter_editing', 'Continuity pass for the Aurelian clock', now, now);
    db.prepare(
      `INSERT INTO messages (id, novel_id, conversation_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('qa-message-opening', NOVEL_ID, 'qa-conversation-continuity', 'assistant', 'QA seeded conversation: verify the full-manuscript clock drift, black compass, cracked seal, and witness ribbon motifs.', now);
  });
  tx();
  const stats = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM chapters WHERE novel_id = ?) AS chapters,
       (SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE novel_id = ?) AS words,
       (SELECT COUNT(*) FROM knowledge_entries WHERE novel_id = ?) AS knowledge,
       (SELECT COUNT(*) FROM knowledge_entries WHERE novel_id = ? AND series_id = ?) AS sharedKnowledge,
       (SELECT COUNT(*) FROM ai_runs WHERE novel_id = ?) AS aiRuns`,
  ).get(NOVEL_ID, NOVEL_ID, NOVEL_ID, NOVEL_ID, SERIES_ID, NOVEL_ID);
  db.close();
  console.log(JSON.stringify({ ok: true, dbPath, vaultPath, novelId: NOVEL_ID, seriesId: SERIES_ID, ...stats }, null, 2));
}

main();
