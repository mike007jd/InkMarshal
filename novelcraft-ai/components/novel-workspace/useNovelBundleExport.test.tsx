// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { useNovelBundleExport } from '@/components/novel-workspace/useNovelBundleExport';

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  saveBlob: vi.fn(),
  toast: vi.fn(),
  notifyExportSaved: vi.fn(),
  recordExportActivity: vi.fn(),
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock('@/lib/desktop-shell-bus', () => ({
  requestManuscriptFlush: mocks.flush,
}));
vi.mock('@/lib/download', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/download')>();
  return { ...original, saveBlob: mocks.saveBlob };
});
vi.mock('@/lib/export-client', () => ({
  notifyExportSaved: mocks.notifyExportSaved,
}));
vi.mock('@/app/actions/activity', () => ({
  recordExportActivity: mocks.recordExportActivity,
}));

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(LocaleProvider, null, children);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('useNovelBundleExport', () => {
  it('flushes the active manuscript before saving and records a completed export', async () => {
    mocks.flush.mockResolvedValue({ ok: true });
    mocks.saveBlob.mockResolvedValue('/tmp/Novel A-bundle.zip');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bundle', {
      status: 200,
      headers: {
        'content-disposition': 'attachment; filename="novel-a.zip"',
      },
    }));
    const { result } = renderHook(
      () => useNovelBundleExport('novel-a', 'Novel A'),
      { wrapper },
    );

    await act(async () => result.current());

    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/novels/novel-a/export-bundle',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    expect(mocks.saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'novel-a.zip');
    expect(mocks.notifyExportSaved).toHaveBeenCalledOnce();
    expect(mocks.recordExportActivity).toHaveBeenCalledWith('novel-a', 'bundle');
  });

  it('aborts an old export and never saves it after the active novel changes', async () => {
    mocks.flush.mockResolvedValue({ ok: true });
    const oldResponse = deferred<Response>();
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockReturnValue(oldResponse.promise);
    const { result, rerender } = renderHook(
      ({ novelId }) => useNovelBundleExport(novelId, novelId),
      { initialProps: { novelId: 'novel-a' }, wrapper },
    );

    let exportPromise!: Promise<void>;
    act(() => {
      exportPromise = result.current();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal;

    rerender({ novelId: 'novel-b' });
    expect(signal.aborted).toBe(true);
    oldResponse.resolve(new Response('old bundle', { status: 200 }));
    await act(async () => exportPromise);

    expect(mocks.saveBlob).not.toHaveBeenCalled();
    expect(mocks.recordExportActivity).not.toHaveBeenCalled();
  });

  it('stops before transport when the active editor cannot flush', async () => {
    mocks.flush.mockResolvedValue({
      ok: false,
      chapterNumber: 4,
      title: 'Storm',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(
      () => useNovelBundleExport('novel-a', 'Novel A'),
      { wrapper },
    );

    await act(async () => result.current());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(String(mocks.toast.mock.calls[0]?.[0])).toContain('Ch.4');
  });
});
