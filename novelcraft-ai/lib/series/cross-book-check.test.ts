import { describe, expect, it } from 'vitest';
import {
  checkSeriesConsistency,
  summarizeConflicts,
  type SeriesMemberOrder,
  type SharedEntryForCheck,
} from '@/lib/series/cross-book-check';

const members: SeriesMemberOrder[] = [
  { novelId: 'book-1', title: 'Book One', order: 0 },
  { novelId: 'book-2', title: 'Book Two', order: 1 },
  { novelId: 'book-3', title: 'Book Three', order: 2 },
];

function entry(crossBookState: Record<string, unknown>): SharedEntryForCheck {
  return { id: 'e1', type: 'character', title: 'Hero', data: { crossBookState } };
}

describe('checkSeriesConsistency', () => {
  it('finds no conflicts for a consistent age progression', () => {
    const conflicts = checkSeriesConsistency([
      entry({ 'book-1': { age: 17 }, 'book-2': { age: 19 }, 'book-3': { age: 25 } }),
    ], members);
    expect(conflicts).toHaveLength(0);
  });

  it('flags an age regression across in-world order', () => {
    const conflicts = checkSeriesConsistency([
      entry({ 'book-1': { age: 30 }, 'book-2': { age: 18 } }),
    ], members);
    const age = conflicts.filter(c => c.kind === 'age_regression');
    expect(age).toHaveLength(1);
    expect(age[0].severity).toBe('major');
    expect(age[0].novelIds).toEqual(['book-1', 'book-2']);
  });

  it('parses numeric-string ages ("17 years")', () => {
    const conflicts = checkSeriesConsistency([
      entry({ 'book-1': { age: '40 years' }, 'book-2': { age: '20' } }),
    ], members);
    expect(conflicts.some(c => c.kind === 'age_regression')).toBe(true);
  });

  it('flags a terminal→active status contradiction', () => {
    const conflicts = checkSeriesConsistency([
      entry({ 'book-1': { status: 'dead' }, 'book-3': { status: 'alive' } }),
    ], members);
    const status = conflicts.filter(c => c.kind === 'status_conflict');
    expect(status.some(c => c.severity === 'major')).toBe(true);
  });

  it('flags two differing free-form statuses as a minor conflict', () => {
    const conflicts = checkSeriesConsistency([
      entry({ 'book-1': { status: 'captured' }, 'book-2': { status: 'free' } }),
    ], members);
    const status = conflicts.filter(c => c.kind === 'status_conflict');
    expect(status).toHaveLength(1);
    expect(status[0].severity).toBe('minor');
  });

  it('flags conflicting relationsDelta notes', () => {
    const conflicts = checkSeriesConsistency([
      entry({
        'book-1': { relationsDelta: 'married to Mei' },
        'book-2': { relationsDelta: 'single, never married' },
      }),
    ], members);
    expect(conflicts.some(c => c.kind === 'relation_conflict')).toBe(true);
  });

  it('ignores entries with state on fewer than two books', () => {
    const conflicts = checkSeriesConsistency([
      entry({ 'book-1': { age: 20 } }),
    ], members);
    expect(conflicts).toHaveLength(0);
  });

  it('ignores entries with no crossBookState at all', () => {
    const conflicts = checkSeriesConsistency([
      { id: 'e2', type: 'character', title: 'Bystander', data: {} },
    ], members);
    expect(conflicts).toHaveLength(0);
  });

  it('summarizeConflicts splits major/minor', () => {
    const conflicts = checkSeriesConsistency([
      entry({ 'book-1': { age: 30, status: 'dead' }, 'book-2': { age: 18, status: 'alive' } }),
    ], members);
    const s = summarizeConflicts(conflicts);
    expect(s.total).toBe(conflicts.length);
    expect(s.major).toBeGreaterThanOrEqual(2); // age regression + status contradiction
    expect(s.major + s.minor).toBe(s.total);
  });
});
