// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { useAIEditChat } from './useAIEditChat';
import type { ChangeItem } from '@/lib/diff-utils';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';

vi.mock('@/lib/streaming-client', () => ({
  buildModelHeaders: vi.fn(async () => ({})),
  consumeNdjsonStream: vi.fn(async (_res: unknown, handlers: { onEvent: (d: Record<string, unknown>) => void | Promise<void> }) => {
    await handlers.onEvent({ type: 'change', id: 'c1', original: 'hello', replacement: 'hi there' });
    await handlers.onEvent({ type: 'done', summary: '1 change' });
  }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => <LocaleProvider>{children}</LocaleProvider>;
const chapter: ManuscriptChapter = { id: 'ch-1', chapterNumber: 1, title: 'One', content: 'hello', version: 1 };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup(opts: { isCurrentEditingScope: () => boolean }) {
  const setChanges = vi.fn();
  const handleClearSelection = vi.fn();
  const setIsLoading = vi.fn();
  const setEditStreaming = vi.fn();
  const changesRef: { current: ChangeItem[] } = { current: [] };
  const view = renderHook(() => useAIEditChat({
    chapter,
    novelId: 'novel-1',
    storageReady: true,
    creativity: 'balanced',
    styleId: null,
    selectedText: undefined,
    isCurrentEditingScope: opts.isCurrentEditingScope,
    changesRef,
    setChanges,
    handleClearSelection,
    setIsLoading,
    setEditStreaming,
    getCurrentEditorContent: () => 'hello',
  }), { wrapper });
  return { ...view, setChanges, handleClearSelection, setIsLoading, setEditStreaming, changesRef };
}

describe('useAIEditChat freeform edit stream', () => {
  it('publishes streamed changes and clears selection when the scope is current', async () => {
    const { result, setChanges, handleClearSelection, setEditStreaming } = setup({ isCurrentEditingScope: () => true });

    await act(async () => { await result.current.handleSend('make it warmer'); });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/novels/novel-1/chapters/1/edit',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(setChanges).toHaveBeenCalledWith([expect.objectContaining({ original: 'hello', replacement: 'hi there' })]);
    expect(handleClearSelection).toHaveBeenCalled();
    expect(setEditStreaming).toHaveBeenCalledWith(false);
  });

  it('ignores stream events for a chapter the user already left', async () => {
    const { result, setChanges, handleClearSelection } = setup({ isCurrentEditingScope: () => false });

    await act(async () => { await result.current.handleSend('make it warmer'); });

    expect(setChanges).not.toHaveBeenCalled();
    expect(handleClearSelection).not.toHaveBeenCalled();
  });
});
