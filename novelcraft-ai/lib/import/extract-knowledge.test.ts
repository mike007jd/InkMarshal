// S3a regression: extractKnowledgeFromManuscript must NOT mask a total
// persistence outage as outcome:'done' with created:0. Before the fix,
// tryCreate() swallowed ALL errors (validation AND persistence) as a skip, so a
// DB locked / disk-full on every entry yielded { outcome:'done', created:0 } —
// silent false-success ("knowledge extraction complete: 0 entries").
//
// Fix: tryCreate now distinguishes validation skips ('skipped') from
// persistence failures ('persist-failed'); when nothing was created AND every
// attempted write failed at the persistence layer, the outcome is 'failed'.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('server-only', () => ({}));

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-kb-extract-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A minimal stand-in LanguageModel — the extraction path never calls it
 *  directly (the AI functions are mocked), it is only threaded through. */
const STUB_MODEL = { modelId: 'stub', specificationVersion: '1' } as unknown as Parameters<
  typeof import('@/lib/import/extract-knowledge').extractKnowledgeFromManuscript
>[0]['model'];

describe('extractKnowledgeFromManuscript — S3a persistence-outcome', () => {
  it('reports outcome:"failed" when every entry write fails at the persistence layer', async () => {
    // Force the AI extraction to return a well-formed entry, then force the
    // persistence layer (createKnowledgeEntry) to throw on every call.
    vi.doMock('@/lib/ai/conversation-extract', () => ({
      extractEntryFromMessageResult: vi.fn(async () => ({
        ok: true as const,
        entry: {
          type: 'character',
          title: 'Hero',
          summary: 'A brave hero',
          data: { description: 'brave' },
          tags: [],
        },
      })),
    }));
    vi.doMock('@/lib/ai/style-extractor', () => ({
      extractStyleNotesResult: vi.fn(async () => ({ ok: false as const })),
      formatStyleNotes: vi.fn(() => ''),
    }));
    vi.doMock('@/app/actions/knowledge', () => ({
      createKnowledgeEntry: vi.fn(async () => {
        throw new Error('simulated DB outage');
      }),
    }));

    vi.resetModules();
    const { extractKnowledgeFromManuscript } = await import('@/lib/import/extract-knowledge');
    const result = await extractKnowledgeFromManuscript({
      novelId: '00000000-0000-0000-0000-000000000000',
      // buildSampleChunks skips bodies shorter than 40 chars; use a long-enough
      // body so the extraction loop actually runs and reaches tryCreate.
      chapters: [{ title: 'One', content: 'The brave hero entered the shining city at dawn, greeted by the bustling crowds.' }],
      model: STUB_MODEL,
      locale: 'en',
    });

    expect(result.outcome).toBe('failed');
    expect(result.created).toBe(0);
    vi.doUnmock('@/app/actions/knowledge');
    vi.doUnmock('@/lib/ai/conversation-extract');
    vi.doUnmock('@/lib/ai/style-extractor');
    vi.resetModules();
  });

  it('reports outcome:"done" when entries are skipped only for validation, not persistence', async () => {
    // AI returns entries whose shape fails schema validation (skip), and the
    // persistence layer is never reached because parse fails first. This must
    // still be 'done' (no persistence outage), not 'failed'.
    vi.doMock('@/lib/ai/conversation-extract', () => ({
      extractEntryFromMessageResult: vi.fn(async () => ({
        ok: true as const,
        // Invalid: type is not a valid KnowledgeType → schema parse throws → skip.
        entry: { type: 'not_a_real_type', title: 'X', data: {}, tags: [] },
      })),
    }));
    vi.doMock('@/lib/ai/style-extractor', () => ({
      extractStyleNotesResult: vi.fn(async () => ({ ok: false as const })),
      formatStyleNotes: vi.fn(() => ''),
    }));
    const createSpy = vi.fn(async () => 'ok');
    vi.doMock('@/app/actions/knowledge', () => ({ createKnowledgeEntry: createSpy }));

    vi.resetModules();
    const { extractKnowledgeFromManuscript } = await import('@/lib/import/extract-knowledge');
    const result = await extractKnowledgeFromManuscript({
      novelId: '00000000-0000-0000-0000-000000000001',
      chapters: [{ title: 'One', content: 'Some prose here that is long enough to clear the chunk threshold.' }],
      model: STUB_MODEL,
      locale: 'en',
    });

    expect(result.outcome).toBe('done');
    expect(result.created).toBe(0);
    expect(createSpy).not.toHaveBeenCalled();
    vi.doUnmock('@/app/actions/knowledge');
    vi.doUnmock('@/lib/ai/conversation-extract');
    vi.doUnmock('@/lib/ai/style-extractor');
    vi.resetModules();
  });
});
