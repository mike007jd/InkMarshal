import { describe, expect, it } from 'vitest';
import {
  buildPersistPayload,
  reconcilePersistedDrafts,
  type PersistedDraftMap,
} from './manuscript-draft-store';

const chapter = (chapterNumber: number, content: string, version?: number) => ({
  chapterNumber,
  content,
  version,
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
