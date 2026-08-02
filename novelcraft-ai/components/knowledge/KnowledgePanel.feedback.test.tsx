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
  window.localStorage.clear();
  // Hydrated renders persist the resolved locale into the locale cookie, which
  // outranks localStorage on the next mount — reset it between tests.
  document.cookie = 'locale=;path=/;max-age=0';
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

  it('names the missing deck categories and offers one complete-with-Assistant action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));
    const onCompleteDeck = vi.fn();

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="character"
            variant="deck"
            coverageCounts={{ character: 0, world: 2, outline: 0 }}
            onCompleteDeck={onCompleteDeck}
          />
        </ToastProvider>
      </LocaleProvider>,
    );

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Still missing: Characters · Outline.');
    expect(status.textContent).not.toContain('World ·');
    const action = within(status).getByRole('button', {
      name: 'Complete Story Deck with Assistant',
    });
    await act(async () => {
      action.click();
    });
    expect(onCompleteDeck).toHaveBeenCalledTimes(1);
  });

  it('hides the recovery callout while coverage is loading or complete', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));
    const view = render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="character"
            variant="deck"
            coverageCounts={{ character: 0, world: 0, outline: 0 }}
            coverageLoading
            onCompleteDeck={vi.fn()}
          />
        </ToastProvider>
      </LocaleProvider>,
    );
    await screen.findByText('No entries yet');
    expect(screen.queryByRole('button', { name: /Complete Story Deck/ })).toBeNull();

    view.rerender(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="character"
            variant="deck"
            coverageCounts={{ character: 1, world: 1, outline: 1 }}
            onCompleteDeck={vi.fn()}
          />
        </ToastProvider>
      </LocaleProvider>,
    );
    expect(screen.queryByRole('button', { name: /Complete Story Deck/ })).toBeNull();
  });

  it('disables the recovery action and announces the running state while the repair is in flight', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="character"
            variant="deck"
            coverageCounts={{ character: 0, world: 0, outline: 0 }}
            repairPhase="running"
            onCompleteDeck={vi.fn()}
          />
        </ToastProvider>
      </LocaleProvider>,
    );

    const action = await screen.findByRole('button', {
      name: 'Assistant is completing the Story Deck…',
    });
    expect(action).toHaveProperty('disabled', true);
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain(
      'Assistant is completing the Story Deck…',
    );
  });

  it('shows a localized failure with a retry action that does not resend automatically', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));
    const onCompleteDeck = vi.fn();

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="character"
            variant="deck"
            coverageCounts={{ character: 0, world: 0, outline: 0 }}
            repairPhase="failed"
            onCompleteDeck={onCompleteDeck}
          />
        </ToastProvider>
      </LocaleProvider>,
    );

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain(
      'The Assistant could not complete the Story Deck. Your chat and draft are unchanged.',
    );
    const retry = within(status).getByRole('button', { name: 'Retry' });
    expect(retry).toHaveProperty('disabled', false);
    await act(async () => {
      retry.click();
    });
    expect(onCompleteDeck).toHaveBeenCalledTimes(1);
  });

  it('disables failed-repair recovery while another Assistant turn is active', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="character"
            variant="deck"
            coverageCounts={{ character: 0, world: 0, outline: 0 }}
            repairPhase="failed"
            assistantBusy
            onCompleteDeck={vi.fn()}
          />
        </ToastProvider>
      </LocaleProvider>,
    );

    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(retry).toHaveProperty('disabled', true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
  });

  it('localizes the recovery callout and action in zh-CN', async () => {
    document.cookie = 'locale=zh-CN;path=/';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([])));

    render(
      <LocaleProvider>
        <ToastProvider>
          <KnowledgePanel
            novelId="novel-1"
            controlledFilter="character"
            variant="deck"
            coverageCounts={{ character: 0, world: 2, outline: 0 }}
            onCompleteDeck={vi.fn()}
          />
        </ToastProvider>
      </LocaleProvider>,
    );

    const action = await screen.findByRole('button', {
      name: '让 Assistant 补齐故事卡组',
    });
    expect(action).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('还缺少：角色 · 蓝图。');
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
