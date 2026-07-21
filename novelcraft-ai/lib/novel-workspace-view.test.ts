import { describe, expect, it } from 'vitest';

import {
  buildNovelEntryHref,
  buildNovelViewHref,
  isPostInterviewStage,
  parseViewParam,
} from '@/lib/novel-workspace-view';

describe('buildNovelEntryHref', () => {
  it('restores the remembered workspace mode for a project entry', () => {
    expect(buildNovelEntryHref('n1', 'story-deck')).toBe('/novel/n1?view=story-deck');
    expect(buildNovelEntryHref('n2', 'read-edit')).toBe('/novel/n2?view=read-edit');
  });

  it('falls back to Agent when no durable preference exists', () => {
    expect(buildNovelEntryHref('n1', null)).toBe('/novel/n1?view=agent');
    expect(buildNovelEntryHref('n1', undefined)).toBe('/novel/n1?view=agent');
  });
});

// `parseViewParam` and `isPostInterviewStage` are the only logic-bearing
// pieces of the new IA layer; everything else is glue/JSX. Pin both so a
// future stage rename or query-string contract change shows up here.
describe('parseViewParam', () => {
  it('returns the parsed view for valid keys', () => {
    expect(parseViewParam('agent')).toBe('agent');
    expect(parseViewParam('story-deck')).toBe('story-deck');
    expect(parseViewParam('read-edit')).toBe('read-edit');
  });

  it('coerces legacy view ids into the current modes', () => {
    expect(parseViewParam('chat')).toBe('agent');
    expect(parseViewParam('conversations')).toBe('agent');
    expect(parseViewParam('knowledge')).toBe('story-deck');
    expect(parseViewParam('story')).toBe('story-deck');
    expect(parseViewParam('deck')).toBe('story-deck');
    expect(parseViewParam('manuscript')).toBe('read-edit');
    expect(parseViewParam('command')).toBe('read-edit');
    expect(parseViewParam('inbox')).toBe('read-edit');
    expect(parseViewParam('publishing')).toBe('read-edit');
  });

  it('rejects unknown view ids', () => {
    expect(parseViewParam('files')).toBeNull();
    expect(parseViewParam('outline')).toBeNull();
    expect(parseViewParam('timeline')).toBeNull();
    expect(parseViewParam('')).toBeNull();
    expect(parseViewParam(null)).toBeNull();
    expect(parseViewParam(undefined)).toBeNull();
  });
});

describe('buildNovelViewHref', () => {
  it('writes the selected workspace mode into the URL', () => {
    expect(buildNovelViewHref('/novel/n1', '?view=agent', 'read-edit'))
      .toBe('/novel/n1?view=read-edit');
  });

  it('preserves manuscript deep-link state and the URL hash', () => {
    expect(buildNovelViewHref(
      '/novel/n1',
      '?view=agent&chapter=3&edit=1&offset=9&autostart=1',
      'story-deck',
      '#selection',
    )).toBe('/novel/n1?view=story-deck&chapter=3&edit=1&offset=9&autostart=1#selection');
  });

  it('adds a canonical mode when the URL has no query string', () => {
    expect(buildNovelViewHref('/novel/n1', '', 'agent')).toBe('/novel/n1?view=agent');
  });

  it('canonicalizes legacy aliases when the user switches modes', () => {
    expect(buildNovelViewHref('/novel/n1', '?view=manuscript', 'read-edit'))
      .toBe('/novel/n1?view=read-edit');
  });
});

describe('isPostInterviewStage', () => {
  it('treats discovery + greenlight stages as pre-interview', () => {
    expect(isPostInterviewStage('discovery_interview')).toBe(false);
    expect(isPostInterviewStage('ready_for_greenlight')).toBe(false);
  });

  it('treats writing, unification, completed as post-interview', () => {
    expect(isPostInterviewStage('autonomous_writing')).toBe(true);
    expect(isPostInterviewStage('whole_book_unification')).toBe(true);
    expect(isPostInterviewStage('completed')).toBe(true);
  });

  it('is null/undefined-safe', () => {
    expect(isPostInterviewStage(null)).toBe(false);
    expect(isPostInterviewStage(undefined)).toBe(false);
  });
});
