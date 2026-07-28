// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  readLocalFile: vi.fn(async () => ({ path: '/tmp/draft.txt', contentsBase64: 'QUJD' })),
  parseImportedFile: vi.fn(),
  importPlanToNovel: vi.fn(),
}));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: () => true,
  readLocalFile: mocks.readLocalFile,
}));

vi.mock('@/lib/streaming-client', () => ({
  buildAIRequestHeaders: async () => ({}),
}));

vi.mock('@/app/actions/import', () => ({
  parseImportedFile: mocks.parseImportedFile,
  importPlanToNovel: mocks.importPlanToNovel,
}));

import { LocaleProvider } from '@/components/LanguageProvider';
import { ToastProvider } from '@/components/Toast';
import { ImportWizard } from '@/components/studio/import/ImportWizard';
import type { ChapterCandidate, DedupeResult } from '@/lib/import/types';

const NOVELS = [
  { id: 'n1', title: 'Novel One' },
  { id: 'n2', title: 'Novel Two' },
];

function candidate(id: string, chapterNumber: number, title: string): ChapterCandidate {
  return {
    id,
    chapterNumber,
    title,
    volumeTitle: null,
    content: `Body of ${title}`,
    wordCount: 100,
    inferred: false,
  };
}

const CANDIDATES = [candidate('c1', 1, 'Opening'), candidate('c2', 2, 'Middle')];

function dedupeReport(action: 'skip' | 'overwrite' | 'append'): DedupeResult[] {
  return CANDIDATES.map(c => ({
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
  mocks.parseImportedFile.mockResolvedValue({
    source: 'txt',
    filename: 'draft.txt',
    suggestedTitle: 'Draft',
    candidates: CANDIDATES,
  });
  mocks.importPlanToNovel.mockResolvedValue({ novelId: 'novel-x', importedChapters: 2 });
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
  it('keeps merge confirm disabled until the report is ready, then sends one decision per candidate', async () => {
    const dedupeA = deferred<Response>();
    fetchMock.mockImplementation((url: string) =>
      url.includes('/import/dedupe')
        ? dedupeA.promise
        : Promise.resolve({ ok: true, json: async () => ({ outcome: 'done', created: 0 }) }),
    );
    renderWizard();
    await pickFile();

    expect(screen.getByText('Checking for matching chapters…')).toBeTruthy();
    expect(confirmButton().disabled).toBe(true);

    dedupeA.resolve({
      ok: true,
      json: async () => dedupeReport('skip'),
    } as Response);
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    fireEvent.click(confirmButton());
    await waitFor(() => expect(mocks.importPlanToNovel).toHaveBeenCalledTimes(1));
    const input = mocks.importPlanToNovel.mock.calls[0][0];
    expect(input.mode).toBe('merge');
    expect(input.targetNovelId).toBe('n1');
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
    expect(screen.queryByText(/network down/)).toBeNull();

    fireEvent.click(screen.getByText('Retry check'));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expect(attempt).toBe(2);
  });

  it.each([
    ['partial', () => dedupeReport('skip').slice(0, 1)],
    ['duplicate candidate id', () => {
      const report = dedupeReport('skip');
      return [report[0], { ...report[1], candidateId: report[0]!.candidateId }];
    }],
    ['illegal decision', () => {
      const report = dedupeReport('skip');
      return [{ ...report[0], defaultAction: 'explode' }, report[1]];
    }],
  ])('fails closed when the dedupe response is %s', async (_label, makeReport) => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/import/dedupe')
        ? Promise.resolve({ ok: true, json: async () => makeReport() })
        : Promise.resolve({ ok: true, json: async () => ({ outcome: 'done', created: 0 }) }),
    );
    renderWizard();
    await pickFile();

    await screen.findByText(
      'Couldn’t check for matching chapters. Nothing was imported — retry to continue.',
    );
    expect(confirmButton().disabled).toBe(true);
    expect(mocks.importPlanToNovel).not.toHaveBeenCalled();
  });

  it('shows the localized failure copy under zh-CN', async () => {
    window.localStorage.setItem('locale', 'zh-CN');
    fetchMock.mockImplementation((url: string) =>
      url.includes('/import/dedupe')
        ? Promise.reject(new Error('network down'))
        : Promise.resolve({ ok: true, json: async () => ({ outcome: 'done', created: 0 }) }),
    );
    renderWizard();
    fireEvent.click(await screen.findByText('选择文件…'));
    await screen.findByText('合并到作品');

    await screen.findByText('无法检查与现有章节的匹配。尚未导入任何内容——请重试以继续。');
    expect(screen.getByText('重试检查')).toBeTruthy();
  });

  it('discards a late response from a previous target after switching targets', async () => {
    const dedupeA = deferred<Response>();
    const dedupeB = deferred<Response>();
    let dedupeCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (!url.includes('/import/dedupe')) {
        return Promise.resolve({ ok: true, json: async () => ({ outcome: 'done', created: 0 }) });
      }
      dedupeCalls += 1;
      return dedupeCalls === 1 ? dedupeA.promise : dedupeB.promise;
    });
    renderWizard();
    await pickFile();
    await screen.findByText('Checking for matching chapters…');

    // Switch the merge target to Novel Two via the target select.
    const targetTrigger = screen.getAllByRole('combobox')[1];
    fireEvent.keyDown(targetTrigger, { key: 'ArrowDown' });
    const option = await screen.findByRole('option', { name: 'Novel Two' });
    fireEvent.click(option);

    // The stale response for n1 arrives late — it must not unlock the confirm.
    dedupeA.resolve({ ok: true, json: async () => dedupeReport('append') } as Response);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/novels/n2/'))).toBe(true));
    expect(confirmButton().disabled).toBe(true);

    // The current report for n2 completes the state machine.
    dedupeB.resolve({ ok: true, json: async () => dedupeReport('overwrite') } as Response);
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    fireEvent.click(confirmButton());
    await waitFor(() => expect(mocks.importPlanToNovel).toHaveBeenCalledTimes(1));
    const input = mocks.importPlanToNovel.mock.calls[0][0];
    expect(input.targetNovelId).toBe('n2');
    expect(input.dedupeDecisions).toEqual([
      { chapterNumber: 1, action: 'overwrite', matchedChapterNumber: 1 },
      { chapterNumber: 2, action: 'overwrite', matchedChapterNumber: 2 },
    ]);
  });

  it('invalidates the report when candidates are edited and requires a re-check', async () => {
    let attempt = 0;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (!url.includes('/import/dedupe')) {
        return Promise.resolve({ ok: true, json: async () => ({ outcome: 'done', created: 0 }) });
      }
      attempt += 1;
      const requested = JSON.parse(opts?.body as string) as {
        candidates: Array<{ id: string }>;
      };
      const report = dedupeReport('append').map((row, index) => ({
        ...row,
        candidateId: requested.candidates[index]!.id,
      }));
      return Promise.resolve({ ok: true, json: async () => report });
    });
    renderWizard();
    await pickFile();
    await waitFor(() => expect(confirmButton().disabled).toBe(false));

    fireEvent.change(screen.getByPlaceholderText('Chapter 1 title'), {
      target: { value: 'Opening (revised)' },
    });

    await screen.findByText('The chapter list changed. Re-check matches before merging.');
    expect(confirmButton().disabled).toBe(true);
    const callsBeforeRecheck = attempt;

    fireEvent.click(screen.getByText('Re-check matches'));
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expect(attempt).toBe(callsBeforeRecheck + 1);
  });

  it('blocks duplicate overwrite targets until the user changes one decision', async () => {
    const report = dedupeReport('overwrite').map(row => ({
      ...row,
      matchedChapterNumber: 10,
      matchedTitle: 'Existing chapter ten',
    }));
    fetchMock.mockImplementation((url: string) =>
      url.includes('/import/dedupe')
        ? Promise.resolve({ ok: true, json: async () => report })
        : Promise.resolve({ ok: true, json: async () => ({ outcome: 'done', created: 0 }) }),
    );
    renderWizard();
    await pickFile();

    await screen.findByText(
      'More than one imported chapter would overwrite existing chapter 10. For each target, change all but one to Skip or Append.',
    );
    expect(confirmButton().disabled).toBe(true);

    const actionSelects = screen.getAllByRole('combobox').slice(2);
    fireEvent.keyDown(actionSelects[1]!, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Append' }));

    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expect(screen.queryByText(/More than one imported chapter would overwrite/)).toBeNull();
  });

  it('new-import mode confirms without any dedupe report', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, json: async () => ({ outcome: 'done', created: 0 }) }),
    );
    renderWizard({ novels: [], initialTargetNovelId: undefined });
    fireEvent.click(screen.getByText('Choose a file…'));
    await screen.findByText('Create novel & import');

    const confirm = screen.getByText('Create novel & import').closest('button') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/import/dedupe'))).toBe(false);

    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.importPlanToNovel).toHaveBeenCalledTimes(1));
    const input = mocks.importPlanToNovel.mock.calls[0][0];
    expect(input.mode).toBe('new');
    expect(input.dedupeDecisions).toBeUndefined();
  });
});
