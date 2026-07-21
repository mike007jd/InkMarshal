// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { ToastProvider } from '@/components/Toast';
import { KnowledgePanel } from '@/components/knowledge/KnowledgePanel';
import { createKnowledgeEntry, updateKnowledgeEntry } from '@/app/actions/knowledge';

vi.mock('@/app/actions/knowledge', () => ({
  createKnowledgeEntry: vi.fn(async () => ({ id: 'new-1' })),
  updateKnowledgeEntry: vi.fn(async () => ({})),
  syncKnowledgeRelationDrafts: vi.fn(async () => ({})),
}));

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function entry(id: string, title: string) {
  return {
    id,
    novelId: 'novel-1',
    type: 'character',
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

describe('KnowledgePanel feedback states', () => {
  it('shows a skeleton while the first load is in flight', async () => {
    let resolveFetch!: (res: Response) => void;
    const pending = new Promise<Response>(done => {
      resolveFetch = done;
    });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel novelId="novel-1" controlledFilter="character" variant="deck" />
        </ToastProvider>
      </LocaleProvider>,
    );

    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeTruthy());

    await act(async () => {
      resolveFetch(okResponse([entry('c1', 'Bear')]));
      await pending;
    });
    expect(await screen.findByText('Bear')).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('surfaces a panel-local error with a working retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response)
      .mockResolvedValueOnce(okResponse([entry('c1', 'Recovered')]));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel novelId="novel-1" controlledFilter="character" variant="deck" />
        </ToastProvider>
      </LocaleProvider>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Failed to load the Story Deck.');

    const retry = within(alert).getByRole('button', { name: 'Retry' });
    await act(async () => {
      retry.click();
    });

    expect(await screen.findByText('Recovered')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches immediately when refreshToken changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const view = render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel novelId="novel-1" controlledFilter="world" variant="deck" refreshToken={0} />
        </ToastProvider>
      </LocaleProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.rerender(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel novelId="novel-1" controlledFilter="world" variant="deck" refreshToken={1} />
        </ToastProvider>
      </LocaleProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('offers a return-to-assistant path from an empty tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));
    const onReturnToAssistant = vi.fn();

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="character"
            variant="deck"
            onReturnToAssistant={onReturnToAssistant}
          />
        </ToastProvider>
      </LocaleProvider>,
    );

    const back = await screen.findByRole('button', { name: 'Return to Assistant to finish the brainstorm' });
    await act(async () => {
      back.click();
    });
    expect(onReturnToAssistant).toHaveBeenCalledTimes(1);
  });

  it('gives the inline form close control an accessible name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel novelId="novel-1" controlledFilter="character" variant="deck" />
        </ToastProvider>
      </LocaleProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('renders coverage counts on the internal tabs and deck summary', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            variant="deck"
            controlledFilter="character"
            coverageCounts={{ character: 4, world: 2, outline: 12 }}
          />
        </ToastProvider>
      </LocaleProvider>,
    );

    await screen.findByText('No entries yet');
    expect(screen.getByText('Characters 4')).toBeTruthy();
    expect(screen.getByText('World 2')).toBeTruthy();
    expect(screen.getByText('Outline 12')).toBeTruthy();
  });
});

function outlineEntry(id: string, title: string) {
  return {
    id,
    novelId: 'novel-1',
    type: 'outline',
    title,
    summary: '',
    sortOrder: 0,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    data: {
      chapterId: '',
      chapterNumber: 1,
      synopsis: '',
      keyEvents: [],
      characters: [],
      pov: '',
      status: 'planned',
      wordCountTarget: 0,
      notes: '',
      level: 'chapter',
      parentId: '',
    },
  };
}

function panelListCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  // The outline-filtered list URL is unique to the panel: the inline form's
  // own relation-target loads hit type=character / type=world instead.
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('type=outline'));
}

describe('KnowledgePanel mutation fan-out', () => {
  afterEach(() => {
    vi.mocked(createKnowledgeEntry).mockClear();
    vi.mocked(updateKnowledgeEntry).mockClear();
  });

  it('refreshes the list exactly once and notifies the parent exactly once after a successful create', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const onEntriesMutated = vi.fn();

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="outline"
            variant="deck"
            onEntriesMutated={onEntriesMutated}
          />
        </ToastProvider>
      </LocaleProvider>,
    );
    await screen.findByText('No entries yet');
    expect(panelListCalls(fetchMock)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(await screen.findByPlaceholderText('Entry title'), {
      target: { value: 'New chapter card' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onEntriesMutated).toHaveBeenCalledTimes(1));
    expect(vi.mocked(createKnowledgeEntry)).toHaveBeenCalledTimes(1);
    // One mutation = one extra list fetch (initial + exactly one refresh).
    await waitFor(() => expect(panelListCalls(fetchMock)).toHaveLength(2));
  });

  it('takes the same single-refresh path after a successful edit', async () => {
    const existing = outlineEntry('o1', 'Opening');
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      const href = String(url);
      if (href.includes('/knowledge/o1')) {
        return Promise.resolve(okResponse({ ...existing, relations: [] }));
      }
      return Promise.resolve(okResponse([existing]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onEntriesMutated = vi.fn();

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="outline"
            variant="deck"
            onEntriesMutated={onEntriesMutated}
          />
        </ToastProvider>
      </LocaleProvider>,
    );

    fireEvent.click(await screen.findByRole('treeitem', { name: /Opening/ }));
    const titleInput = await screen.findByPlaceholderText('Entry title');
    fireEvent.change(titleInput, { target: { value: 'Opening (revised)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(onEntriesMutated).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updateKnowledgeEntry)).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(panelListCalls(fetchMock)).toHaveLength(2));
  });

  it('does not notify the parent when the save fails', async () => {
    vi.mocked(createKnowledgeEntry).mockRejectedValueOnce(new Error('disk full'));
    const fetchMock = vi.fn().mockResolvedValue(okResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const onEntriesMutated = vi.fn();

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="outline"
            variant="deck"
            onEntriesMutated={onEntriesMutated}
          />
        </ToastProvider>
      </LocaleProvider>,
    );
    await screen.findByText('No entries yet');

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(await screen.findByPlaceholderText('Entry title'), {
      target: { value: 'Doomed card' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect((await screen.findAllByText('disk full')).length).toBeGreaterThan(0);
    expect(onEntriesMutated).not.toHaveBeenCalled();
    expect(panelListCalls(fetchMock)).toHaveLength(1);
  });
});
