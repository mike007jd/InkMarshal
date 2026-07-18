// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { useChapterDraftController } from './useChapterDraftController';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';

const wrapper = ({ children }: { children: React.ReactNode }) => <LocaleProvider>{children}</LocaleProvider>;

const chapter: ManuscriptChapter = { id: 'ch-1', chapterNumber: 1, title: 'One', content: 'hello', version: 2 };
const otherChapter: ManuscriptChapter = { id: 'ch-2', chapterNumber: 2, title: 'Two', content: 'world', version: 7 };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useChapterDraftController persistence', () => {
  it('flushes a dirty buffer with the optimistic version and notifies on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: 3 }) } as Response);
    const onChaptersChange = vi.fn();
    const onSaveStatusChange = vi.fn();
    const editorRef = { current: null };

    const { result } = renderHook(() => useChapterDraftController({
      novelId: 'novel-1',
      chapter,
      storageReady: true,
      editorRef,
      onChaptersChange,
      onSaveStatusChange,
    }), { wrapper });

    act(() => { result.current.handleContentChange('hello world'); });
    await act(async () => { await result.current.flushSave(); });

    expect(fetchMock).toHaveBeenCalledWith('/api/novels/novel-1/chapters/1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ content: 'hello world', version: 2 }),
    }));
    expect(onChaptersChange).toHaveBeenCalled();
    expect(onSaveStatusChange).toHaveBeenCalledWith('saved', expect.any(Number));
  });

  it('keeps the buffer dirty and surfaces a failed status on a 409 conflict', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) } as Response);
    const onSaveStatusChange = vi.fn();
    const editorRef = { current: null };

    const { result } = renderHook(() => useChapterDraftController({
      novelId: 'novel-1',
      chapter,
      storageReady: true,
      editorRef,
      onSaveStatusChange,
    }), { wrapper });

    act(() => { result.current.handleContentChange('conflicting edit'); });
    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.flushSave(); });

    expect(ok).toBe(false);
    expect(onSaveStatusChange).toHaveBeenCalledWith('failed', null);
  });

  it('flushes the outgoing chapter before repointing scope on a chapter switch', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ version: 3 }) } as Response);
    const editorRef = { current: null };

    const { result } = renderHook(() => useChapterDraftController({
      novelId: 'novel-1',
      chapter,
      storageReady: true,
      editorRef,
    }), { wrapper });

    // Dirty the current chapter, then simulate a switch to chapter 2.
    act(() => { result.current.handleContentChange('edited ch1'); });
    await act(async () => {
      await result.current.maybeFlushOnChapterSwitch('novel-1', otherChapter);
      result.current.applyChapterSwitch('novel-1', otherChapter, undefined);
    });

    // The dirty buffer for chapter 1 was persisted (scope still pointed at ch1
    // during the flush) before the refs moved to chapter 2.
    expect(fetchMock).toHaveBeenCalledWith('/api/novels/novel-1/chapters/1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ content: 'edited ch1', version: 2 }),
    }));
    // Scope now reports chapter 2 as current and chapter 1 as stale.
    expect(result.current.isCurrentEditingScope({ novelId: 'novel-1', chapterId: 'ch-2', chapterNumber: 2 })).toBe(true);
    expect(result.current.isCurrentEditingScope({ novelId: 'novel-1', chapterId: 'ch-1', chapterNumber: 1 })).toBe(false);
    expect(result.current.editorSync.content).toBe('world');
  });
});
