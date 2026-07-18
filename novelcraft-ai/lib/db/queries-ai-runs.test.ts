// Integration tests for the ai_runs query layer against real SQLite (schema
// 0015) via the temp-DATA_DIR + getDb pattern. Covers: append + aggregate
// GROUP BY, accept rebuild, the baseline table creation,
// novel_id ON DELETE SET NULL survival, and the cost-per-accepted-kWord metric
// resolving accepted words from either ai_runs.accepted_words OR the chapter's
// generation_meta.actualWords (the one-phase degrade path).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_USER_ID } from '@/lib/local-user';

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-airuns-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function mods() {
  return {
    runs: await import('@/lib/db/queries-ai-runs'),
    db: await import('@/lib/db'),
    conn: await import('@/lib/db/connection'),
  };
}

async function freshNovel(): Promise<string> {
  const { db } = await mods();
  const novel = await db.createNovel({ userId: LOCAL_USER_ID, title: 'AR' });
  return novel.id;
}

// Clear the ledger between cases so aggregates are deterministic.
beforeEach(async () => {
  const { conn } = await mods();
  conn.getDb().prepare('DELETE FROM ai_runs').run();
});

describe('ai_runs table baseline', () => {
  it('creates ai_runs with its indexes', async () => {
    const { conn } = await mods();
    const table = conn
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_runs'")
      .get();
    expect(table).toBeTruthy();
    const indexes = conn
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ai_runs'")
      .all() as { name: string }[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_ai_runs_novel');
    expect(names).toContain('idx_ai_runs_model_op');
  });
});

describe('insertAiRun + aggregateAiRuns', () => {
  it('appends rows and groups by operation × model with SUM/AVG', async () => {
    const { runs } = await mods();
    const novelId = await freshNovel();

    runs.insertAiRun({
      novelId,
      chapterNumber: 1,
      operation: 'chapter',
      role: 'draft',
      connectionKind: 'provider',
      providerId: 'anthropic',
      modelId: 'claude-x',
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      firstTokenMs: 400,
      durationMs: 5000,
      outcome: 'success',
      estCostUsd: 0.5,
    });
    runs.insertAiRun({
      novelId,
      chapterNumber: 2,
      operation: 'chapter',
      role: 'draft',
      connectionKind: 'provider',
      providerId: 'anthropic',
      modelId: 'claude-x',
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      firstTokenMs: 600,
      durationMs: 3000,
      outcome: 'failed',
      estCostUsd: null,
    });

    const agg = runs.aggregateAiRuns({ novelId });
    expect(agg).toHaveLength(1);
    const row = agg[0];
    expect(row.operation).toBe('chapter');
    expect(row.modelId).toBe('claude-x');
    expect(row.runs).toBe(2);
    expect(row.successes).toBe(1);
    expect(row.failures).toBe(1);
    expect(row.totalTokens).toBe(500);
    expect(row.avgFirstTokenMs).toBe(500); // (400 + 600) / 2
    expect(row.estCostUsd).toBeCloseTo(0.5, 6); // only the priced row contributes
    expect(row.pricedRuns).toBe(1); // the null-cost row is unpriced
  });

  it('filters by time window (since)', async () => {
    const { runs, conn } = await mods();
    const novelId = await freshNovel();
    runs.insertAiRun({ novelId, operation: 'chat', outcome: 'success' });
    // Back-date the row well outside a recent window.
    conn
      .getDb()
      .prepare("UPDATE ai_runs SET created_at = '2000-01-01T00:00:00.000Z'")
      .run();
    runs.insertAiRun({ novelId, operation: 'chat', outcome: 'success' });

    const recent = runs.aggregateAiRuns({
      novelId,
      since: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(recent.reduce((n, r) => n + r.runs, 0)).toBe(1);

    const all = runs.aggregateAiRuns({ novelId });
    expect(all.reduce((n, r) => n + r.runs, 0)).toBe(2);
  });
});

describe('markAiRunAccepted', () => {
  it('rebuilds accepted + accepted_words on a run', async () => {
    const { runs, conn } = await mods();
    const novelId = await freshNovel();
    const id = runs.insertAiRun({
      novelId,
      chapterNumber: 1,
      operation: 'chapter',
      connectionKind: 'provider',
      providerId: 'anthropic',
      modelId: 'claude-x',
      outcome: 'success',
      estCostUsd: 1.0,
    });

    runs.markAiRunAccepted(id, 1200);

    const row = conn
      .getDb()
      .prepare('SELECT accepted, accepted_words FROM ai_runs WHERE id = ?')
      .get(id) as { accepted: number; accepted_words: number };
    expect(row.accepted).toBe(1);
    expect(row.accepted_words).toBe(1200);
  });
});

describe('costPerAcceptedKWord', () => {
  it('uses ai_runs.accepted_words when present', async () => {
    const { runs } = await mods();
    const novelId = await freshNovel();
    const id = runs.insertAiRun({
      novelId,
      chapterNumber: 1,
      operation: 'chapter',
      connectionKind: 'provider',
      providerId: 'anthropic',
      modelId: 'claude-x',
      outcome: 'success',
      estCostUsd: 2.0,
    });
    runs.markAiRunAccepted(id, 1000);

    const rows = runs.costPerAcceptedKWord(novelId);
    const claude = rows.find(r => r.modelId === 'claude-x');
    expect(claude).toBeDefined();
    expect(claude!.acceptedWords).toBe(1000);
    // $2.00 over 1000 accepted words → $2.00 / kWord.
    expect(claude!.costPerKWord).toBeCloseTo(2.0, 6);
  });

  it('degrades to chapter generation_meta.actualWords when no accept rebuild', async () => {
    const { runs, conn } = await mods();
    const novelId = await freshNovel();
    // Write a chapter row with generation_meta carrying actualWords.
    conn
      .getDb()
      .prepare(
        `INSERT INTO chapters (id, novel_id, chapter_number, title, content, word_count, version, created_at, generation_meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        novelId,
        1,
        'Ch1',
        'body',
        800,
        0,
        new Date().toISOString(),
        JSON.stringify({ actualWords: 800, targetWords: 800, attempts: 1, modelId: 'm', generatedAt: 'x' }),
      );

    runs.insertAiRun({
      novelId,
      chapterNumber: 1,
      operation: 'chapter',
      connectionKind: 'provider',
      providerId: 'anthropic',
      modelId: 'claude-x',
      outcome: 'success',
      estCostUsd: 1.6,
    });

    const rows = runs.costPerAcceptedKWord(novelId);
    const claude = rows.find(r => r.modelId === 'claude-x');
    expect(claude).toBeDefined();
    expect(claude!.acceptedWords).toBe(800);
    expect(claude!.costPerKWord).toBeCloseTo(2.0, 6); // 1.6 / 800 * 1000
  });

  it('flags a model whose accepted runs are all unpriced as unknown (not free)', async () => {
    const { runs } = await mods();
    const novelId = await freshNovel();
    const id = runs.insertAiRun({
      novelId,
      chapterNumber: 1,
      operation: 'chapter',
      connectionKind: 'provider',
      providerId: 'anthropic',
      modelId: 'pricey-cloud',
      outcome: 'success',
      estCostUsd: null, // no price on file
    });
    runs.markAiRunAccepted(id, 1000);

    const rows = runs.costPerAcceptedKWord(novelId);
    const row = rows.find(r => r.modelId === 'pricey-cloud');
    expect(row).toBeDefined();
    expect(row!.costPerKWord).toBeNull(); // unknown, NOT $0
    expect(row!.hasUnpricedRuns).toBe(true);
  });

  it('does not rank a partially unpriced model from its incomplete cost', async () => {
    const { runs } = await mods();
    const novelId = await freshNovel();
    const priced = runs.insertAiRun({
      novelId,
      operation: 'chapter',
      connectionKind: 'provider',
      providerId: 'provider-x',
      modelId: 'partial-price',
      outcome: 'success',
      estCostUsd: 1,
    });
    const unpriced = runs.insertAiRun({
      novelId,
      operation: 'chapter',
      connectionKind: 'provider',
      providerId: 'provider-x',
      modelId: 'partial-price',
      outcome: 'success',
      estCostUsd: null,
    });
    runs.markAiRunAccepted(priced, 500);
    runs.markAiRunAccepted(unpriced, 500);

    const row = runs.costPerAcceptedKWord(novelId).find(item => item.modelId === 'partial-price');
    expect(row?.hasUnpricedRuns).toBe(true);
    expect(row?.costPerKWord).toBeNull();
  });

  it('applies the selected time window to cost per accepted word', async () => {
    const { runs, conn } = await mods();
    const novelId = await freshNovel();
    const oldRun = runs.insertAiRun({
      novelId,
      operation: 'chapter',
      connectionKind: 'provider',
      modelId: 'windowed-model',
      outcome: 'success',
      estCostUsd: 9,
    });
    const recentRun = runs.insertAiRun({
      novelId,
      operation: 'chapter',
      connectionKind: 'provider',
      modelId: 'windowed-model',
      outcome: 'success',
      estCostUsd: 1,
    });
    runs.markAiRunAccepted(oldRun, 1_000);
    runs.markAiRunAccepted(recentRun, 1_000);
    conn.getDb().prepare('UPDATE ai_runs SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', oldRun);

    const since = new Date(Date.now() - 86_400_000).toISOString();
    const row = runs.costPerAcceptedKWord(novelId, since).find(item => item.modelId === 'windowed-model');
    expect(row?.acceptedWords).toBe(1_000);
    expect(row?.costPerKWord).toBeCloseTo(1, 6);
  });

  it('local runs cost ~0 per kWord', async () => {
    const { runs } = await mods();
    const novelId = await freshNovel();
    const id = runs.insertAiRun({
      novelId,
      chapterNumber: 1,
      operation: 'chapter',
      connectionKind: 'local',
      providerId: 'openai-compatible',
      modelId: 'qwen-local',
      outcome: 'success',
      estCostUsd: 0,
    });
    runs.markAiRunAccepted(id, 1000);

    const rows = runs.costPerAcceptedKWord(novelId);
    const row = rows.find(r => r.modelId === 'qwen-local');
    expect(row!.costPerKWord).toBe(0);
    expect(row!.hasUnpricedRuns).toBe(false);
  });

  // S8: a non-accepted run must attribute its cost from its OWN generated_words
  // (captured at generation time), not the mutable chapters row — which always
  // reflects the LATEST regeneration and would mis-attribute an older run.
  it('uses the run own generated_words for a non-accepted regenerated chapter', async () => {
    const { runs, conn } = await mods();
    const novelId = await freshNovel();
    // The chapter row now reflects the LATEST generation (actualWords 9999).
    conn
      .getDb()
      .prepare(
        `INSERT INTO chapters (id, novel_id, chapter_number, title, content, word_count, version, created_at, generation_meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        novelId,
        1,
        'Ch1',
        'latest body',
        9999,
        5,
        new Date().toISOString(),
        JSON.stringify({ actualWords: 9999, targetWords: 9999, attempts: 5, modelId: 'm', generatedAt: 'x' }),
      );

    // An EARLIER generation of the same chapter that produced only 500 words,
    // never accepted. generated_words pins the run's own count so the metric
    // does NOT pick up the latest 9999.
    runs.insertAiRun({
      novelId,
      chapterNumber: 1,
      operation: 'chapter',
      connectionKind: 'provider',
      providerId: 'anthropic',
      modelId: 'claude-x',
      outcome: 'success',
      estCostUsd: 1.0,
      generatedWords: 500,
    });

    const rows = runs.costPerAcceptedKWord(novelId);
    const claude = rows.find(r => r.modelId === 'claude-x');
    expect(claude).toBeDefined();
    // The run's own 500 wins — NOT the latest chapter's 9999.
    expect(claude!.acceptedWords).toBe(500);
    expect(claude!.costPerKWord).toBeCloseTo(2.0, 6); // 1.0 / 500 * 1000
  });
});

describe('novel_id ON DELETE SET NULL', () => {
  it('keeps the run row with a NULL novel_id after the novel is deleted', async () => {
    const { runs, db, conn } = await mods();
    const novelId = await freshNovel();
    runs.insertAiRun({
      novelId,
      chapterNumber: 1,
      operation: 'chapter',
      modelId: 'claude-x',
      outcome: 'success',
      estCostUsd: 0.1,
    });

    await db.deleteNovelCascade(novelId, LOCAL_USER_ID);

    const rows = conn
      .getDb()
      .prepare('SELECT novel_id FROM ai_runs WHERE model_id = ?')
      .all('claude-x') as { novel_id: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].novel_id).toBeNull();
  });
});
