// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '@/components/LanguageProvider';
import { ToastProvider } from '@/components/Toast';
import { KnowledgePanel } from '@/components/knowledge/KnowledgePanel';

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
