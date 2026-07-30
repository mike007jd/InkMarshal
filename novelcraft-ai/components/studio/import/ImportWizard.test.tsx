// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  stageManuscriptImport: vi.fn(async () => ({ token: 'a'.repeat(64), basename: 'draft.txt' })),
  openImportSessionAction: vi.fn(),
  confirmImportSessionAction: vi.fn(),
}));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: () => true,
  stageManuscriptImport: mocks.stageManuscriptImport,
}));

vi.mock('@/lib/streaming-client', () => ({
  buildAIRequestHeaders: async () => ({}),
}));

vi.mock('@/app/actions/import', () => ({
  openImportSessionAction: mocks.openImportSessionAction,
  confirmImportSessionAction: mocks.confirmImportSessionAction,
}));

import { LocaleProvider } from '@/components/LanguageProvider';
import { ToastProvider } from '@/components/Toast';
import { ImportWizard } from '@/components/studio/import/ImportWizard';
import type { DedupeResult, ImportPreviewChapter } from '@/lib/import/types';

const NOVELS = [
  { id: 'n1', title: 'Novel One' },
  { id: 'n2', title: 'Novel Two' },
];

function previewChapter(id: string, chapterNumber: number, title: string): ImportPreviewChapter {
  return {
    id,
    chapterNumber,
    title,
    volumeTitle: null,
    wordCount: 100,
    inferred: false,
    snippet: `Body of ${title}`,
    paragraphs: [`Body of ${title}`],
    parts: [{ segmentId: `seg-${chapterNumber}`, fromParagraph: 0, toParagraph: 1 }],
  };
}

const CHAPTERS = [previewChapter('c1', 1, 'Opening'), previewChapter('c2', 2, 'Middle')];

function dedupeReport(action: 'skip' | 'overwrite' | 'append'): DedupeResult[] {
  return CHAPTERS.map(c => ({
    candidateId: c.id,
    status: action === 'skip'
      ? 'duplicate' as const
      : action === 'overwrite'
        ? 'conflict' as const
        : 'new' as const,
    matchedChapterNumber: action === 'append' ? null : c.chapterNumber,
    matchedTitle: action === 'append' ? null : `Existing ${c.title}`,
    defaultAction: action,
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fetchMock = vi.fn();

function renderWizard(props: Partial<Parameters<typeof ImportWizard>[0]> = {}) {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <ImportWizard
          open
          onClose={() => {}}
          novels={NOVELS}
          onImported={() => {}}
          initialTargetNovelId="n1"
          {...props}
        />
      </ToastProvider>
    </LocaleProvider>,
  );
}

async function pickFile() {
  fireEvent.click(screen.getByText('Choose a file…'));
  await screen.findByText('Merge into novel');
}

function confirmButton(): HTMLButtonElement {
  return screen.getByText('Merge into novel').closest('button') as HTMLButtonElement;
}

function clearLocale() {
  window.localStorage.clear();
  document.cookie = 'locale=;path=/;max-age=0';
}

// jsdom has no layout engine; Radix Select scrolls the active item into view.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

beforeEach(() => {
  vi.clearAllMocks();
  clearLocale();
  vi.stubGlobal('fetch', fetchMock);
  mocks.openImportSessionAction.mockResolvedValue({
    sessionToken: 'a'.repeat(64),
    source: 'txt',
    filename: 'draft.txt',
    suggestedTitle: 'Draft',
    chapters: CHAPTERS,
  });
  mocks.confirmImportSessionAction.mockResolvedValue({ novelId: 'novel-x', importedChapters: 2 });
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: 'en',
  });
});

afterEach(() => {
  cleanup();
  clearLocale();
  vi.unstubAllGlobals();
});

describe('ImportWizard merge dedupe state machine', () => {
  it('keeps merge confirm disabled until the report is ready, then sends compact refs only', async () => {
    const dedupeA = deferred<Response>();
    fetchMock.mockImplementation((url: string) =>
      url.includes('/import/dedupe')
        ? dedupeA.promise
        : Promise.resolve({ ok: true, json: async () => ({ outcome: 'done', created: 0 }) }),
    );
    renderWizard();
    await pickFile();

    expect(mocks.stageManuscriptImport).toHaveBeenCalledTimes(1);
    expect(mocks.openImportSessionAction).toHaveBeenCalledWith({
      token: 'a'.repeat(64),
      basename: 'draft.txt',
    });

    expect(screen.getByText('Checking for matching chapters…')).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);

    dedupeA.resolve({
      ok: true,
      json: async () => dedupeReport('skip'),
    } as Response);
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    fireEvent.click(confirmButton());
    await waitFor(() => expect(mocks.confirmImportSessionAction).toHaveBeenCalledTimes(1));
    const input = mocks.confirmImportSessionAction.mock.calls[0][0];
    expect(input.mode).toBe('merge');
    expect(input.targetNovelId).toBe('n1');
    expect(input.sessionToken).toBe('a'.repeat(64));
    expect(input.chapters).toEqual([
      { title: 'Opening', parts: CHAPTERS[0]!.parts },
      { title: 'Middle', parts: CHAPTERS[1]!.parts },
    ]);
    expect(JSON.stringify(input)).not.toContain('Body of');
    expect(input.dedupeDecisions).toEqual([
      { chapterNumber: 1, action: 'skip', matchedChapterNumber: 1 },
      { chapterNumber: 2, action: 'skip', matchedChapterNumber: 2 },
    ]);
  });

  it('surfaces a localized error with retry on network failure and recovers', async () => {
    let attempt = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes('/import/dedupe')) {
        return Promise.resolve({ ok: true, json: async () => ({ outcome: 'done', created: 0 }) });
      }
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('network down'))
        : Promise.resolve({ ok: true, json: async () => dedupeReport('append') });
    });
    renderWizard();
    await pickFile();

    await screen.findByText(
      'Couldn’t check for matching chapters. Nothing was imported — retry to continue.',
    );
    expect(confirmButton().disabled).toBe(true);

    fireEvent.click(screen.getByText('Retry check'));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
  });

  it('marks the report stale after a title edit and blocks confirm until re-check', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => dedupeReport('append'),
    });
    renderWizard();
    await pickFile();
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    const titleInput = screen.getByDisplayValue('Opening');
    fireEvent.change(titleInput, { target: { value: 'Opening revised' } });

    await screen.findByText('The chapter list changed. Re-check matches before merging.');
    expect(confirmButton().disabled).toBe(true);
    expect(mocks.confirmImportSessionAction).not.toHaveBeenCalled();
  });

  it('sends dedupe request with session token and parts, never chapter content', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => dedupeReport('append'),
    });
    renderWizard();
    await pickFile();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const dedupeCall = fetchMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('/import/dedupe'),
    );
    expect(dedupeCall).toBeTruthy();
    const init = dedupeCall![1] as { body: string };
    const body = JSON.parse(init.body) as {
      sessionToken: string;
      chapters: { id: string; title: string; parts: unknown; content?: string }[];
    };
    expect(body.sessionToken).toBe('a'.repeat(64));
    expect(body.chapters[0]).toMatchObject({
      id: 'c1',
      title: 'Opening',
      parts: CHAPTERS[0]!.parts,
    });
    expect(body.chapters[0]).not.toHaveProperty('content');
  });
});
