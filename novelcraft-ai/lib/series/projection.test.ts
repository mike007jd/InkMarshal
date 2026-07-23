import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/queries-knowledge-vault', () => ({
  getKnowledgeIndexById: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/db/queries-vault', () => ({
  getKnowledgeIndexRowByPath: vi.fn().mockResolvedValue(null),
}));
import {
  mergeSharedEntryForNovel,
  buildSharedProjectionInsert,
  sharedProjectionId,
  isSharedProjectionPath,
  SHARED_PROJECTION_PREFIX,
  type SharedEntrySource,
} from '@/lib/series/projection';

function baseShared(data: Record<string, unknown>): SharedEntrySource {
  return {
    id: 'entry-1',
    type: 'character',
    title: 'Lin Shen',
    summary: 'A wandering swordsman.',
    data,
    tags: ['hero'],
    updatedAt: '2026-06-26T00:00:00.000Z',
  };
}

describe('mergeSharedEntryForNovel', () => {
  it('returns the canonical value for a member with no overrides + strips overlay bags', () => {
    const shared = baseShared({
      role: 'protagonist',
      description: 'Stoic.',
      perNovelOverrides: { 'book-b': { description: 'Reckless.' } },
      crossBookState: { 'book-b': { age: 30 } },
    });
    const merged = mergeSharedEntryForNovel(shared, 'book-a');
    expect(merged.data.description).toBe('Stoic.');
    // Overlay bags never travel into the projected view.
    expect(merged.data.perNovelOverrides).toBeUndefined();
    expect(merged.data.crossBookState).toBeUndefined();
  });

  it('applies the per-novel override patch over the canonical value', () => {
    const shared = baseShared({
      description: 'Stoic.',
      perNovelOverrides: { 'book-b': { description: 'Reckless.', mood: 'angry' } },
    });
    const a = mergeSharedEntryForNovel(shared, 'book-a');
    const b = mergeSharedEntryForNovel(shared, 'book-b');
    expect(a.data.description).toBe('Stoic.'); // untouched in book A
    expect(b.data.description).toBe('Reckless.'); // overridden in book B
    expect(b.data.mood).toBe('angry');
  });

  it('applies crossBookState age/status as effective fields, override wins last', () => {
    const shared = baseShared({
      description: 'Stoic.',
      crossBookState: { 'book-b': { age: 45, status: 'dead' } },
      perNovelOverrides: { 'book-b': { status: 'undead' } },
    });
    const b = mergeSharedEntryForNovel(shared, 'book-b');
    expect(b.data.age).toBe(45);
    // explicit override beats crossBookState-derived status
    expect(b.data.status).toBe('undead');
  });
});

describe('buildSharedProjectionInsert', () => {
  it('namespaces the path under shared/ and uses a deterministic projection id', async () => {
    const shared = baseShared({ description: 'Stoic.' });
    const insert = await buildSharedProjectionInsert(shared, 'book-a');
    expect(insert.id).toBe(sharedProjectionId('entry-1', 'book-a'));
    expect(insert.id).toBe('entry-1::book-a');
    expect(insert.novelId).toBe('book-a');
    expect(isSharedProjectionPath(insert.path)).toBe(true);
    expect(insert.path.startsWith(`${SHARED_PROJECTION_PREFIX}character/`)).toBe(true);
  });

  it('a member with an override gets a different projected data blob than the anchor view', async () => {
    const shared = baseShared({
      description: 'Stoic.',
      perNovelOverrides: { 'book-b': { description: 'Reckless.' } },
    });
    const a = await buildSharedProjectionInsert(shared, 'book-a');
    const b = await buildSharedProjectionInsert(shared, 'book-b');
    const aData = JSON.parse(a.data) as Record<string, unknown>;
    const bData = JSON.parse(b.data) as Record<string, unknown>;
    expect(aData.description).toBe('Stoic.');
    expect(bData.description).toBe('Reckless.');
    // Distinct ids, distinct content hashes (override changed the body).
    expect(a.id).not.toBe(b.id);
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
