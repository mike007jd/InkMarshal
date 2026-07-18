// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { useDiffConfirmation } from './useDiffConfirmation';
import type { ManuscriptChapter } from '@/components/ManuscriptShell';

const wrapper = ({ children }: { children: React.ReactNode }) => <LocaleProvider>{children}</LocaleProvider>;

const chapter: ManuscriptChapter = { id: 'ch-1', chapterNumber: 1, title: 'One', content: 'The quick brown fox', version: 1 };

function setup() {
  const applyTextThroughEditor = vi.fn();
  const handleClearSelection = vi.fn();
  const editorRef = { current: null };
  const view = renderHook(() => useDiffConfirmation({
    novelId: 'novel-1',
    chapter,
    editorRef,
    applyTextThroughEditor,
    handleClearSelection,
  }), { wrapper });
  return { ...view, applyTextThroughEditor, handleClearSelection };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDiffConfirmation', () => {
  it('stages a rewrite change at the highlighted range and clears the selection', () => {
    const { result, handleClearSelection } = setup();

    act(() => {
      result.current.pushGeneratedTextAsChange({
        mode: 'rewrite',
        generated: 'slow',
        originalSelection: 'quick',
        highlightRange: { start: 4, end: 9 },
      });
    });

    expect(result.current.changes).toHaveLength(1);
    expect(result.current.changes[0]).toMatchObject({
      original: 'quick',
      replacement: 'slow',
      status: 'pending',
      location: { start: 4, end: 9 },
    });
    expect(handleClearSelection).toHaveBeenCalled();
  });

  it('creates one recovery snapshot before writing accepted changes through the editor', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const { result, applyTextThroughEditor } = setup();

    act(() => {
      result.current.pushGeneratedTextAsChange({
        mode: 'rewrite',
        generated: 'slow',
        originalSelection: 'quick',
        highlightRange: { start: 4, end: 9 },
      });
    });
    act(() => { result.current.handleAcceptAll(); });

    await waitFor(() => expect(applyTextThroughEditor).toHaveBeenCalledWith('The slow brown fox'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/novels/novel-1/chapters/1/snapshots',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ label: 'Before AI edit' }),
      }),
    );
  });

  it('keeps the proposal pending and does not write when the recovery snapshot fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    const { result, applyTextThroughEditor } = setup();

    act(() => {
      result.current.pushGeneratedTextAsChange({
        mode: 'rewrite',
        generated: 'slow',
        originalSelection: 'quick',
        highlightRange: { start: 4, end: 9 },
      });
    });
    act(() => { result.current.handleAcceptAll(); });

    await waitFor(() => expect(result.current.changes[0].status).toBe('pending'));
    expect(applyTextThroughEditor).not.toHaveBeenCalled();
  });

  it('does not touch the editor when the only change is rejected', () => {
    const { result, applyTextThroughEditor } = setup();

    act(() => {
      result.current.pushGeneratedTextAsChange({
        mode: 'rewrite',
        generated: 'slow',
        originalSelection: 'quick',
        highlightRange: { start: 4, end: 9 },
      });
    });
    act(() => { result.current.handleReject(result.current.changes[0].id); });

    expect(applyTextThroughEditor).not.toHaveBeenCalled();
    expect(result.current.changes[0].status).toBe('rejected');
  });
});
