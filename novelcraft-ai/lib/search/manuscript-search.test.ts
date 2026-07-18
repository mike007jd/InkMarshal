import { describe, expect, it } from 'vitest';

import { searchManuscriptSync } from './manuscript-search';

const chapters = [
  {
    chapterNumber: 1,
    title: 'The Cloud at Dawn',
    content: 'Far over the misty mountains cold lay a soft cloud of dust. The traveler watched.',
  },
  {
    chapterNumber: 2,
    title: '雪山之上',
    content: '远方的山峦藏在云雾里。她抬头望去，云朵层层叠叠，让人想起故乡的天空。',
  },
  {
    chapterNumber: 3,
    title: 'Quiet Lake',
    content: '',
  },
];

describe('searchManuscriptSync', () => {
  it('returns empty array for empty query', () => {
    expect(searchManuscriptSync(chapters, '')).toEqual([]);
    expect(searchManuscriptSync(chapters, '   ')).toEqual([]);
  });

  it('matches case-insensitively in english body text', () => {
    const results = searchManuscriptSync(chapters, 'cloud');
    expect(results.length).toBeGreaterThan(0);
    // Title match should outrank body matches (weight = 1.5).
    expect(results[0].field).toBe('title');
    expect(results[0].chapterNumber).toBe(1);
  });

  it('matches chinese substrings without tokenisation (≥2 chars)', () => {
    const results = searchManuscriptSync(chapters, '云雾');
    expect(results.length).toBeGreaterThan(0);
    const chineseHits = results.filter(r => r.chapterNumber === 2);
    expect(chineseHits.length).toBeGreaterThan(0);
    // At least one body match must include the highlighted substring.
    const bodyHit = chineseHits.find(r => r.field === 'body');
    expect(bodyHit).toBeTruthy();
    const slice = bodyHit!.snippet.slice(bodyHit!.highlight.start, bodyHit!.highlight.end);
    expect(slice).toBe('云雾');
  });

  it('ignores single-character CJK queries (too noisy)', () => {
    // A lone ideograph matches inside too many compounds — require ≥2 chars,
    // matching recall.ts `containsName`. Latin single-char queries still match.
    expect(searchManuscriptSync(chapters, '云')).toEqual([]);
  });

  it('builds a snippet of bounded length around the match', () => {
    const results = searchManuscriptSync(chapters, 'traveler');
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.snippet.length).toBeLessThanOrEqual(30 * 2 + 'traveler'.length + 2);
    const slice = r.snippet.slice(r.highlight.start, r.highlight.end);
    expect(slice.toLowerCase()).toBe('traveler');
  });

  it('skips empty content chapters silently', () => {
    const results = searchManuscriptSync(chapters, 'quiet');
    // Title hit on ch 3
    expect(results.some(r => r.chapterNumber === 3 && r.field === 'title')).toBe(true);
  });

  it('rejects queries longer than 100 chars', () => {
    const longQuery = 'x'.repeat(101);
    expect(searchManuscriptSync(chapters, longQuery)).toEqual([]);
  });

  it('caps results at 50', () => {
    const wordy = Array.from({ length: 20 }, (_, i) => ({
      chapterNumber: i + 1,
      title: `Chapter ${i + 1}`,
      content: ('the the the the the ' as string).repeat(20),
    }));
    const results = searchManuscriptSync(wordy, 'the');
    expect(results.length).toBeLessThanOrEqual(50);
  });

  it('normalizes NFKC + lowercase', () => {
    // Fullwidth latin lookalike → NFKC folds to ascii
    const r = searchManuscriptSync(
      [{ chapterNumber: 1, title: 'A', content: 'Ｈｅｌｌｏ world' }],
      'hello',
    );
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].field).toBe('body');
  });

  it('maps normalized matches back to original offsets for expanded unicode characters', () => {
    const results = searchManuscriptSync(
      [{ chapterNumber: 1, title: 'A', content: 'Start ﬃ end' }],
      'ffi',
    );

    expect(results.length).toBe(1);
    const match = results[0];
    expect(match.offset).toBe('Start '.length);
    expect(match.snippet.slice(match.highlight.start, match.highlight.end)).toBe('ﬃ');
  });
});
