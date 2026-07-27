// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useNovelWorkspaceNavigation } from '@/components/novel-workspace/useNovelWorkspaceNavigation';

const navigationState = vi.hoisted(() => ({
  params: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => navigationState.params,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  navigationState.params = new URLSearchParams();
  window.history.replaceState(null, '', '/novel/novel-a');
});

describe('useNovelWorkspaceNavigation', () => {
  it('projects valid manuscript deep-link fields and rejects invalid numeric fields', () => {
    navigationState.params = new URLSearchParams(
      'view=read-edit&chapter=3&edit=1&offset=0&autostart=1',
    );
    const { result } = renderHook(() =>
      useNovelWorkspaceNavigation('novel-a', 'agent'));

    expect(result.current).toMatchObject({
      view: 'read-edit',
      chapterFromUrl: 3,
      startInEditing: true,
      searchOffsetFromUrl: 0,
      autostart: true,
    });

    cleanup();
    navigationState.params = new URLSearchParams(
      'view=read-edit&chapter=-1&offset=1.5',
    );
    const invalid = renderHook(() =>
      useNovelWorkspaceNavigation('novel-a', 'agent'));
    expect(invalid.result.current.chapterFromUrl).toBeNull();
    expect(invalid.result.current.searchOffsetFromUrl).toBeNull();
  });

  it('updates the current history entry and accepts desktop menu view events', () => {
    const { result } = renderHook(() =>
      useNovelWorkspaceNavigation('novel-a', 'agent'));

    act(() => result.current.selectView('story-deck'));
    expect(result.current.view).toBe('story-deck');
    expect(window.location.search).toBe('?view=story-deck');
    expect(window.history.length).toBeGreaterThan(0);

    act(() => {
      window.dispatchEvent(new CustomEvent('inkmarshal://menu', {
        detail: { view: 'read-edit' },
      }));
    });
    expect(result.current.view).toBe('read-edit');
    expect(window.location.search).toBe('?view=read-edit');
  });
});
