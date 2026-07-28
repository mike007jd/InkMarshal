// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useNovelWorkspaceNavigation } from '@/components/novel-workspace/useNovelWorkspaceNavigation';

const navigationState = vi.hoisted(() => ({
  params: new URLSearchParams(),
  toast: vi.fn(),
  flush: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => navigationState.params,
}));
vi.mock('@/components/LanguageProvider', () => ({
  useLanguage: () => ({
    t: { editorSaveError: 'Save failed — will retry' },
  }),
}));
vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: navigationState.toast }),
}));
vi.mock('@/lib/desktop-shell-bus', async () => {
  const actual = await vi.importActual<typeof import('@/lib/desktop-shell-bus')>(
    '@/lib/desktop-shell-bus',
  );
  return {
    ...actual,
    requestManuscriptFlush: navigationState.flush,
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  navigationState.params = new URLSearchParams();
  navigationState.flush.mockResolvedValue({ ok: true });
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

  it('updates the current history entry and accepts desktop menu view events', async () => {
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
    expect(navigationState.flush).not.toHaveBeenCalled();
  });

  it('awaits flush before leaving read-edit and blocks the transition on failure', async () => {
    const { result } = renderHook(() =>
      useNovelWorkspaceNavigation('novel-a', 'read-edit'));

    navigationState.flush.mockResolvedValueOnce({ ok: false });
    act(() => result.current.selectView('agent'));
    await waitFor(() => {
      expect(navigationState.flush).toHaveBeenCalledOnce();
      expect(navigationState.toast).toHaveBeenCalledWith('Save failed — will retry', 'error');
    });
    expect(result.current.view).toBe('read-edit');
    expect(window.location.search).toBe('');

    navigationState.flush.mockResolvedValueOnce({ ok: true });
    act(() => result.current.selectView('story-deck'));
    await waitFor(() => {
      expect(result.current.view).toBe('story-deck');
    });
    expect(window.location.search).toBe('?view=story-deck');
  });

  it('applies the same leave-read-edit flush barrier to menu events', async () => {
    const { result } = renderHook(() =>
      useNovelWorkspaceNavigation('novel-a', 'read-edit'));

    act(() => {
      window.dispatchEvent(new CustomEvent('inkmarshal://menu', {
        detail: { view: 'agent' },
      }));
    });

    await waitFor(() => {
      expect(navigationState.flush).toHaveBeenCalledOnce();
      expect(result.current.view).toBe('agent');
    });
  });
});
