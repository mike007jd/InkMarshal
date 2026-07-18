import { describe, expect, it } from 'vitest';

import {
  dedupeCandidates,
  fingerprintBody,
  normalizeTitle,
} from '@/lib/import/dedupe';
import type { ChapterCandidate, ExistingChapterRef } from '@/lib/import/types';

function cand(partial: Partial<ChapterCandidate> & { id: string }): ChapterCandidate {
  return {
    chapterNumber: 1,
    title: '',
    volumeTitle: null,
    content: '',
    wordCount: 0,
    inferred: false,
    ...partial,
  };
}

describe('normalizeTitle', () => {
  it('strips a leading chapter ordinal so the human title is compared', () => {
    expect(normalizeTitle('第三章 启程')).toBe(normalizeTitle('启程'));
    expect(normalizeTitle('Chapter 3: The Journey')).toBe(normalizeTitle('The Journey'));
  });

  it('folds whitespace, case and punctuation', () => {
    expect(normalizeTitle('  The  Journey! ')).toBe(normalizeTitle('the journey'));
    expect(normalizeTitle('启程。')).toBe('启程');
  });

  it('folds a bare ordinal with no title to empty', () => {
    expect(normalizeTitle('第三章')).toBe('');
    expect(normalizeTitle('Chapter 3')).toBe('');
  });
});

describe('fingerprintBody', () => {
  it('is stable under whitespace/punctuation noise', () => {
    expect(fingerprintBody('主角  离开了，村庄。')).toBe(fingerprintBody('主角离开了村庄'));
  });

  it('differs when the opening prose differs', () => {
    expect(fingerprintBody('完全不同的开头甲')).not.toBe(fingerprintBody('完全不同的开头乙'));
  });
});

describe('dedupeCandidates', () => {
  const existing: ExistingChapterRef[] = [
    { chapterNumber: 1, title: '第一章 出发', content: '主角离开了村庄，踏上旅途。' },
    { chapterNumber: 2, title: '第二章 抵达', content: '他到了繁华的城里。' },
  ];

  it('flags an exact re-import (same title + same body) as duplicate → skip', () => {
    const [res] = dedupeCandidates(
      [cand({ id: 'a', title: '第一章 出发', content: '主角离开了村庄，踏上旅途。' })],
      existing,
    );
    expect(res.status).toBe('duplicate');
    expect(res.defaultAction).toBe('skip');
    expect(res.matchedChapterNumber).toBe(1);
  });

  it('flags same title + changed body as conflict → overwrite', () => {
    const [res] = dedupeCandidates(
      [cand({ id: 'a', title: '第一章 出发', content: '完全改写过的开头，与原文不同。' })],
      existing,
    );
    expect(res.status).toBe('conflict');
    expect(res.defaultAction).toBe('overwrite');
    expect(res.matchedChapterNumber).toBe(1);
  });

  it('flags same body under a different title as conflict (renamed chapter)', () => {
    const [res] = dedupeCandidates(
      [cand({ id: 'a', title: '崭新的标题', content: '主角离开了村庄，踏上旅途。' })],
      existing,
    );
    expect(res.status).toBe('conflict');
    expect(res.matchedChapterNumber).toBe(1);
  });

  it('flags a genuinely new chapter as new → append', () => {
    const [res] = dedupeCandidates(
      [cand({ id: 'a', title: '第三章 新篇', content: '一段全新的内容在此展开。' })],
      existing,
    );
    expect(res.status).toBe('new');
    expect(res.defaultAction).toBe('append');
    expect(res.matchedChapterNumber).toBeNull();
  });

  it('matches the human title even when the ordinal prefix differs', () => {
    // Incoming "第99章 出发" vs existing "第一章 出发": the ordinal is stripped,
    // so both reduce to "出发" and the body confirms the duplicate.
    const [res] = dedupeCandidates(
      [cand({ id: 'a', title: '第99章 出发', content: '主角离开了村庄，踏上旅途。' })],
      existing,
    );
    expect(res.status).toBe('duplicate');
    expect(res.matchedChapterNumber).toBe(1);
  });

  it('returns one result per candidate in order', () => {
    const results = dedupeCandidates(
      [
        cand({ id: 'a', title: '第一章 出发', content: '主角离开了村庄，踏上旅途。' }),
        cand({ id: 'b', title: '第三章 新篇', content: '一段全新的内容。' }),
      ],
      existing,
    );
    expect(results.map(r => r.candidateId)).toEqual(['a', 'b']);
    expect(results[0].status).toBe('duplicate');
    expect(results[1].status).toBe('new');
  });

  it('treats everything as new against an empty target', () => {
    const [res] = dedupeCandidates(
      [cand({ id: 'a', title: '第一章', content: '正文' })],
      [],
    );
    expect(res.status).toBe('new');
  });
});

// S10b: a stub/placeholder chapter whose normalized title AND body fingerprint
// both collapse to '' (all-punctuation body + ordinal-only title) used to
// always classify as 'new' → append, so re-importing the same stub appended a
// duplicate every time. The raw fallback key lets identical stubs dedup.
describe('dedupeCandidates — S10b stub/placeholder fallback', () => {
  it('dedupes an identical all-punctuation stub instead of appending a duplicate', () => {
    const existing: ExistingChapterRef[] = [
      // An all-punctuation body + ordinal-only title → fingerprint '' + normTitle ''.
      { chapterNumber: 3, title: '第三章', content: '……' },
    ];
    const [res] = dedupeCandidates(
      [cand({ id: 'stub-again', chapterNumber: 3, title: '第三章', content: '……' })],
      existing,
    );
    expect(res.status).toBe('duplicate');
    expect(res.matchedChapterNumber).toBe(3);
    expect(res.defaultAction).toBe('skip');
  });

  it('still treats a genuinely different stub as new', () => {
    const existing: ExistingChapterRef[] = [
      { chapterNumber: 3, title: '第三章', content: '……' },
    ];
    // Different raw content → different fallback key → still 'new'.
    const [res] = dedupeCandidates(
      [cand({ id: 'diff-stub', chapterNumber: 4, title: '第四章', content: 'TBD' })],
      existing,
    );
    expect(res.status).toBe('new');
  });
});
