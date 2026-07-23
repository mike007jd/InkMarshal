// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildPersistPayload,
  clearManuscriptRecovery,
  CorruptManuscriptRecoveryError,
  loadPersistedDrafts,
  persistDrafts,
  reconcilePersistedDrafts,
  type PersistedDraftMap,
} from './manuscript-draft-store';

const chapter = (chapterNumber: number, content: string, version?: number) => ({
  chapterNumber,
  content,
  version,
});

beforeEach(() => {
  localStorage.clear();
});

describe('durable manuscript recovery store', () => {
  it('keeps every novel under one fixed app-setting key', () => {
    persistDrafts('novel-1', {
      '1': { content: 'first draft', version: 2, savedAt: 100 },
    });
    persistDrafts('novel-2', {
      '4': { content: 'second draft', version: 7, savedAt: 200 },
    });

    expect(loadPersistedDrafts('novel-1')['1']?.content).toBe('first draft');
    expect(loadPersistedDrafts('novel-2')['4']?.content).toBe('second draft');
    expect(localStorage.getItem('inkmarshal_manuscript_recovery_v1')).not.toBeNull();
    expect(localStorage.getItem('inkmarshal:manuscript-drafts:v1:novel-1')).toBeNull();
  });

  it('removes only the cleared novel from the shared recovery envelope', () => {
    persistDrafts('novel-1', {
      '1': { content: 'first draft', version: 2, savedAt: 100 },
    });
    persistDrafts('novel-2', {
      '4': { content: 'second draft', version: 7, savedAt: 200 },
    });

    persistDrafts('novel-1', {});

    expect(loadPersistedDrafts('novel-1')).toEqual({});
    expect(loadPersistedDrafts('novel-2')['4']?.content).toBe('second draft');
  });

  it('fails closed without overwriting malformed persisted recovery data', () => {
    const raw = '{"novel-1":{"1":{"content":42}}}';
    localStorage.setItem('inkmarshal_manuscript_recovery_v1', raw);

    expect(() => loadPersistedDrafts('novel-1')).toThrow(CorruptManuscriptRecoveryError);
    expect(() => persistDrafts('novel-1', {
      '1': { content: 'replacement', version: 1, savedAt: 1 },
    })).toThrow(CorruptManuscriptRecoveryError);
    expect(localStorage.getItem('inkmarshal_manuscript_recovery_v1')).toBe(raw);
  });

  it('explicitly clears corrupt recovery data without parsing or rewriting it', async () => {
    localStorage.setItem('inkmarshal_manuscript_recovery_v1', '{"broken":');

    await expect(clearManuscriptRecovery()).resolves.toBe(true);
    expect(localStorage.getItem('inkmarshal_manuscript_recovery_v1')).toBeNull();
  });
});

describe('buildPersistPayload', () => {
  it('prefers the live draft version over the chapter prop version', () => {
    const payload = buildPersistPayload(
      new Map([[1, 'draft text']]),
      new Map([[1, 5]]),
      [chapter(1, 'db text', 3)],
      1000,
    );
    expect(payload['1']).toEqual({ content: 'draft text', version: 5, savedAt: 1000 });
  });

  it('falls back to the chapter version, then 0', () => {
    const payload = buildPersistPayload(
      new Map([[1, 'a'], [2, 'b']]),
      new Map(),
      [chapter(1, 'x', 7)],
      0,
    );
    expect(payload['1'].version).toBe(7);
    expect(payload['2'].version).toBe(0);
  });
});

describe('reconcilePersistedDrafts', () => {
  it('restores a draft when the chapter version still matches and content differs', () => {
    const stored: PersistedDraftMap = {
      '1': { content: 'unsaved edit', version: 3, savedAt: 0 },
    };
    const { restored, hadStaleEntries } = reconcilePersistedDrafts(stored, [
      chapter(1, 'db text', 3),
    ]);
    expect(restored.get(1)).toBe('unsaved edit');
    expect(hadStaleEntries).toBe(false);
  });

  it('drops a draft when the DB moved on (newer version)', () => {
    const stored: PersistedDraftMap = {
      '1': { content: 'old draft', version: 3, savedAt: 0 },
    };
    const { restored, hadStaleEntries } = reconcilePersistedDrafts(stored, [
      chapter(1, 'newer db text', 4),
    ]);
    expect(restored.size).toBe(0);
    expect(hadStaleEntries).toBe(true);
  });

  it('drops a draft whose content already matches the chapter (save landed)', () => {
    const stored: PersistedDraftMap = {
      '1': { content: 'same text', version: 3, savedAt: 0 },
    };
    const { restored } = reconcilePersistedDrafts(stored, [chapter(1, 'same text', 3)]);
    expect(restored.size).toBe(0);
  });

  it('drops drafts for chapters that no longer exist', () => {
    const stored: PersistedDraftMap = {
      '9': { content: 'ghost', version: 1, savedAt: 0 },
    };
    const { restored, hadStaleEntries } = reconcilePersistedDrafts(stored, [
      chapter(1, 'x', 1),
    ]);
    expect(restored.size).toBe(0);
    expect(hadStaleEntries).toBe(true);
  });

  it('treats a missing chapter version as 0', () => {
    const stored: PersistedDraftMap = {
      '1': { content: 'draft', version: 0, savedAt: 0 },
    };
    const { restored } = reconcilePersistedDrafts(stored, [chapter(1, 'db', undefined)]);
    expect(restored.get(1)).toBe('draft');
  });
});
