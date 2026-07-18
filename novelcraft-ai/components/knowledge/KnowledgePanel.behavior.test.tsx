// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { ToastProvider } from '@/components/Toast';
import { KnowledgePanel } from '@/components/knowledge/KnowledgePanel';

type DeferredResponse = {
  promise: Promise<Response>;
  resolve: (body: unknown) => void;
};

function deferredResponse(): DeferredResponse {
  let resolve!: (body: unknown) => void;
  const promise = new Promise<Response>(done => {
    resolve = body => done({ ok: true, status: 200, json: async () => body } as Response);
  });
  return { promise, resolve };
}

function entry(id: string, type: 'character' | 'world', title: string) {
  return {
    id,
    novelId: 'novel-1',
    type,
    title,
    summary: '',
    sortOrder: 0,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    data: {},
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('KnowledgePanel request ordering', () => {
  it('ignores an older response after the controlled filter changes', async () => {
    const characters = deferredResponse();
    const world = deferredResponse();
    const fetchMock = vi.fn()
      .mockReturnValueOnce(characters.promise)
      .mockReturnValueOnce(world.promise);
    vi.stubGlobal('fetch', fetchMock);

    const view = render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel novelId="novel-1" controlledFilter="character" variant="deck" />
        </ToastProvider>
      </LocaleProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    view.rerender(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel novelId="novel-1" controlledFilter="world" variant="deck" />
        </ToastProvider>
      </LocaleProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      world.resolve([entry('world', 'world', 'Current world')]);
      await world.promise;
    });
    expect(await screen.findByText('Current world')).toBeTruthy();

    await act(async () => {
      characters.resolve([entry('character', 'character', 'Stale character')]);
      await characters.promise;
    });
    expect(screen.queryByText('Stale character')).toBeNull();
    expect(screen.getByText('Current world')).toBeTruthy();
  });
});
