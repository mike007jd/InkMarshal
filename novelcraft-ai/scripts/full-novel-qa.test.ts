import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const NOVEL_ID = 'qa-full-novel-scale';
const SETTINGS_KEY = 'inkmarshal_settings';
const qaDataDir = process.env.FULL_NOVEL_QA_DATA_DIR?.trim();
const exportDir = process.env.FULL_NOVEL_QA_EXPORT_DIR?.trim() || '/tmp/inkmarshal-live-qa/exports';
const requiresQaEnv = process.env.npm_lifecycle_event === 'qa:full-novel-coverage';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
const PREV_EMBED_BASE_URL = process.env.INKMARSHAL_EMBED_BASE_URL;
const PREV_RUNTIME = process.env.INKMARSHAL_RUNTIME;

function assertHarnessPaths(dataDir: string): void {
  const resolvedDataDir = path.resolve(dataDir);
  if (resolvedDataDir.includes(`${path.sep}.inkmarshal${path.sep}app`)) {
    throw new Error('FULL_NOVEL_QA_DATA_DIR must point at an isolated copied DB, not the real InkMarshal data dir.');
  }
  const resolvedExportDir = path.resolve(exportDir);
  const relativeToTemp = path.relative(path.resolve(tmpdir()), resolvedExportDir);
  if (relativeToTemp.startsWith('..') || path.isAbsolute(relativeToTemp)) {
    throw new Error('FULL_NOVEL_QA_EXPORT_DIR must stay under the OS temporary directory for this destructive export rewrite.');
  }
}

function openQaDb(): Database.Database {
  if (!qaDataDir) throw new Error('FULL_NOVEL_QA_DATA_DIR is required.');
  return new Database(path.join(qaDataDir, 'inkmarshal.db'));
}

function loadNovelFixture() {
  const db = openQaDb();
  try {
    const novel = db.prepare(
      `SELECT title, genre, story_summary AS storySummary, character_summary AS characterSummary,
              arc_summary AS arcSummary, stage
         FROM novels
        WHERE id = ?`,
    ).get(NOVEL_ID) as {
      title: string;
      genre: string;
      storySummary: string;
      characterSummary: string;
      arcSummary: string;
      stage: string;
    } | undefined;
    const chapters = db.prepare(
      `SELECT chapter_number AS chapterNumber, title, content
         FROM chapters
        WHERE novel_id = ?
        ORDER BY chapter_number ASC`,
    ).all(NOVEL_ID) as { chapterNumber: number; title: string; content: string }[];
    if (!novel) throw new Error(`Missing QA novel ${NOVEL_ID}`);
    return { novel, chapters };
  } finally {
    db.close();
  }
}

if (!qaDataDir && requiresQaEnv) {
  describe('full-novel QA harness', () => {
    it('requires FULL_NOVEL_QA_DATA_DIR', () => {
      throw new Error('Set FULL_NOVEL_QA_DATA_DIR to an isolated seeded data dir before running this QA harness.');
    });
  });
}

const runQa = qaDataDir ? describe : describe.skip;

runQa('full-novel QA harness', () => {
  beforeAll(() => {
    assertHarnessPaths(qaDataDir!);
    process.env.INKMARSHAL_DATA_DIR = qaDataDir;
    process.env.INKMARSHAL_EMBED_BASE_URL = '';
    process.env.INKMARSHAL_RUNTIME = 'desktop';
    rmSync(exportDir, { recursive: true, force: true });
    mkdirSync(exportDir, { recursive: true });
  });

  afterAll(async () => {
    const { closeDbForTest } = await import('@/lib/db/connection');
    closeDbForTest();
    if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
    else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
    if (PREV_EMBED_BASE_URL === undefined) delete process.env.INKMARSHAL_EMBED_BASE_URL;
    else process.env.INKMARSHAL_EMBED_BASE_URL = PREV_EMBED_BASE_URL;
    if (PREV_RUNTIME === undefined) delete process.env.INKMARSHAL_RUNTIME;
    else process.env.INKMARSHAL_RUNTIME = PREV_RUNTIME;
  });

  it('exports TXT, DOCX, and PDF, then re-parses the TXT as an import smoke', async () => {
    const { buildNovelTxt } = await import('@/lib/exporters/text');
    const { buildNovelDocxBuffer } = await import('@/lib/exporters/docx');
    const { buildNovelPdfBuffer } = await import('@/lib/exporters/pdf');
    const { parseText } = await import('@/lib/import/parse-text');
    const { detectChapters } = await import('@/lib/import/detect-chapters');
    const { novel, chapters } = loadNovelFixture();

    expect(chapters).toHaveLength(80);

    const txt = buildNovelTxt(novel, chapters);
    const docx = await buildNovelDocxBuffer(novel, chapters);
    const pdf = await buildNovelPdfBuffer(novel, chapters);

    const txtPath = path.join(exportDir, 'The Aurelian Archive.txt');
    const docxPath = path.join(exportDir, 'The Aurelian Archive.docx');
    const pdfPath = path.join(exportDir, 'The Aurelian Archive.pdf');
    writeFileSync(txtPath, txt);
    writeFileSync(docxPath, docx);
    writeFileSync(pdfPath, pdf);

    expect(readFileSync(txtPath, 'utf8')).toContain('Chapter 80: 80 -');
    expect(readFileSync(docxPath).subarray(0, 2).toString()).toBe('PK');
    expect(readFileSync(pdfPath).subarray(0, 4).toString()).toBe('%PDF');
    expect(statSync(txtPath).size).toBeGreaterThan(500_000);
    expect(statSync(docxPath).size).toBeGreaterThan(10_000);
    expect(statSync(pdfPath).size).toBeGreaterThan(10_000);

    const imported = detectChapters(parseText(txt, 'aurelian-export.txt', 'txt'));
    expect(imported).toHaveLength(80);
    expect(imported[0].content).toContain('black compass');
  }, 60_000);

  it('proves shared series knowledge, projection, and a clean cross-book check', async () => {
    const {
      listSharedEntriesForSeries,
      reprojectSharedEntriesForSeries,
    } = await import('@/lib/db/queries-series');
    const { getSeriesDetail, runCrossBookCheck } = await import('@/app/actions/series');

    const db = openQaDb();
    let seriesId: string;
    try {
      seriesId = (db.prepare('SELECT series_id FROM novels WHERE id = ?').get(NOVEL_ID) as { series_id: string }).series_id;
    } finally {
      db.close();
    }

    const shared = await listSharedEntriesForSeries(seriesId);
    expect(shared.map(entry => entry.title)).toEqual(['Aurelian Harbor']);

    await reprojectSharedEntriesForSeries(seriesId);

    const projectedDb = openQaDb();
    try {
      const projected = projectedDb.prepare(
        "SELECT id, path FROM knowledge_index WHERE novel_id = ? AND path LIKE 'shared/%'",
      ).all(NOVEL_ID) as { id: string; path: string }[];
      expect(projected).toHaveLength(1);
      expect(projected[0].id).toBe(`${shared[0].id}::${NOVEL_ID}`);
      expect(projected[0].path).toContain('shared/world/');
    } finally {
      projectedDb.close();
    }

    const detail = await getSeriesDetail(seriesId);
    expect(detail.members.map(member => member.id)).toEqual([NOVEL_ID]);
    expect(detail.sharedEntries.map(entry => entry.title)).toEqual(['Aurelian Harbor']);

    const report = await runCrossBookCheck(seriesId);
    expect(report.summary).toEqual({ total: 0, major: 0, minor: 0 });
  });

  it('round-trips disposable Story Deck CRUD and a reversible settings write', async () => {
    const { createKnowledgeEntry, updateKnowledgeEntry, deleteKnowledgeEntry } = await import('@/app/actions/knowledge');
    const { PATCH, GET } = await import('@/app/api/app-settings/route');
    const { closeDbForTest } = await import('@/lib/db/connection');

    const created = await createKnowledgeEntry(NOVEL_ID, {
      type: 'world',
      title: 'QA Disposable Harbor Marker',
      tags: ['qa-disposable'],
      data: {
        category: 'location',
        description: 'Temporary Story Deck CRUD coverage marker.',
        details: { purpose: 'phase2-qa' },
      },
    });

    await updateKnowledgeEntry(created.id, {
      title: 'QA Disposable Harbor Marker Edited',
      data: {
        category: 'location',
        description: 'Edited temporary Story Deck CRUD coverage marker.',
        details: { purpose: 'phase2-qa', state: 'edited' },
      },
      tags: ['qa-disposable', 'edited'],
    });

    let db = openQaDb();
    try {
      const row = db.prepare('SELECT title, data FROM knowledge_entries WHERE id = ?').get(created.id) as
        | { title: string; data: string }
        | undefined;
      expect(row?.title).toBe('QA Disposable Harbor Marker Edited');
      expect(JSON.parse(row!.data).details.state).toBe('edited');
    } finally {
      db.close();
    }

    await deleteKnowledgeEntry(created.id);
    db = openQaDb();
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_entries WHERE id = ?').get(created.id)).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_index WHERE id = ?').get(created.id)).toEqual({ n: 0 });
    } finally {
      db.close();
    }

    const beforeResponse = await GET();
    const beforeJson = await beforeResponse.json() as { settings?: Record<string, string> };
    const before = beforeJson.settings?.[SETTINGS_KEY] ?? null;
    const next = JSON.stringify({ theme: 'dark', fontSize: 'large', qaPhase: 'phase2' });

    const patchResponse = await PATCH(new Request('http://localhost/api/app-settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: SETTINGS_KEY, value: next }),
    }));
    expect(patchResponse.status).toBe(200);

    closeDbForTest();
    const reloadResponse = await GET();
    const reloadJson = await reloadResponse.json() as { settings?: Record<string, string> };
    expect(reloadJson.settings?.[SETTINGS_KEY]).toBe(next);

    await PATCH(new Request('http://localhost/api/app-settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: SETTINGS_KEY, value: before }),
    }));
    closeDbForTest();
  });

  it('left export artifacts in the expected disposable folder', () => {
    for (const filename of ['The Aurelian Archive.txt', 'The Aurelian Archive.docx', 'The Aurelian Archive.pdf']) {
      expect(existsSync(path.join(exportDir, filename))).toBe(true);
    }
  });
});
