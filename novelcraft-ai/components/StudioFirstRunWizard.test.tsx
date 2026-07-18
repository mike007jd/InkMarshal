// @vitest-environment jsdom

import { createElement } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LanguageProvider } from '@/components/LanguageProvider';
import { StudioFirstRunWizard, resolveStarterRowAffordance } from '@/components/StudioFirstRunWizard';

const wizardMocks = vi.hoisted(() => ({
  downloadStarterModel: vi.fn(),
  getDesktopStatus: vi.fn(),
  listInstalledLocalModels: vi.fn(),
  startAndBindLocalEngine: vi.fn(),
  notifyLocalModelStateChanged: vi.fn(),
}));

vi.mock('@/components/hooks/useClientMacPlatform', () => ({
  useClientMacPlatform: () => true,
}));

vi.mock('@/lib/desktop-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/desktop-runtime')>();
  return {
    ...actual,
    isTauriRuntime: () => true,
    getDesktopStatus: wizardMocks.getDesktopStatus,
    listInstalledLocalModels: wizardMocks.listInstalledLocalModels,
  };
});

vi.mock('@/lib/model-supply/starter-models', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/model-supply/starter-models')>();
  return {
    ...actual,
    getStarterModelDetails: () => [{
      id: 'starter-model',
      name: 'Starter Model',
      lifecycle: 'recommended',
      role: 'draft',
      category: 'Writing',
      gguf: { repo: 'vendor/starter-model' },
      lastVerifiedAt: '2026-07-13',
      sourceUrls: [],
    }],
    pickPrimaryStarterId: () => 'starter-model',
    resolveStarterFormat: () => 'gguf',
    repoForStarterEntry: () => 'vendor/starter-model',
    downloadStarterModel: wizardMocks.downloadStarterModel,
  };
});

vi.mock('@/lib/model-supply/orchestrator', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/model-supply/orchestrator')>();
  return { ...actual, startAndBindLocalEngine: wizardMocks.startAndBindLocalEngine };
});

vi.mock('@/lib/model-supply/local-model-events', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/model-supply/local-model-events')>();
  return { ...actual, notifyLocalModelStateChanged: wizardMocks.notifyLocalModelStateChanged };
});

beforeEach(() => {
  vi.clearAllMocks();
  wizardMocks.getDesktopStatus.mockResolvedValue({
    desktop: true,
    platform: 'macos',
    model_dir: '/models',
    total_memory_bytes: 16 * 1024 ** 3,
  });
  wizardMocks.listInstalledLocalModels.mockResolvedValue([]);
  wizardMocks.startAndBindLocalEngine.mockResolvedValue(undefined);
});

describe('resolveStarterRowAffordance', () => {
  it('never reports a green "ready" when the engine failed to bind, even though bytes are on disk', () => {
    // installedHere is true (file downloaded) but binding failed — must NOT be "ready".
    expect(resolveStarterRowAffordance('bindFailed', true)).toBe('bindFailed');
  });

  it('reports ready only when installed and in no failure/transition state', () => {
    expect(resolveStarterRowAffordance(undefined, true)).toBe('ready');
    expect(resolveStarterRowAffordance('idle', true)).toBe('ready');
  });

  it('treats downloading and verifying as the same in-flight affordance', () => {
    expect(resolveStarterRowAffordance('downloading', false)).toBe('downloading');
    expect(resolveStarterRowAffordance('verifying', false)).toBe('downloading');
    // download/verify in flight wins even if a stale install lingers on disk.
    expect(resolveStarterRowAffordance('downloading', true)).toBe('downloading');
  });

  it('shows the binding spinner while a rebind is in progress', () => {
    expect(resolveStarterRowAffordance('binding', true)).toBe('binding');
    expect(resolveStarterRowAffordance('binding', false)).toBe('binding');
  });

  it('falls back to the download/retry button for fresh and failed downloads', () => {
    expect(resolveStarterRowAffordance(undefined, false)).toBe('download');
    expect(resolveStarterRowAffordance('failed', false)).toBe('download');
  });
});

describe('StudioFirstRunWizard download lifecycle', () => {
  it('starts and announces a downloaded model even when the wizard unmounts mid-download', async () => {
    let resolveDownload!: (path: string) => void;
    wizardMocks.downloadStarterModel.mockReturnValueOnce(
      new Promise<string>(resolve => { resolveDownload = resolve; }),
    );

    const { unmount } = render(
      createElement(
        LanguageProvider,
        null,
        createElement(StudioFirstRunWizard, { installedCount: 0 }),
      ),
    );
    const installButton = await screen.findByRole('button', { name: /install.*use/i });
    await waitFor(() => expect((installButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(installButton);
    await waitFor(() => expect(wizardMocks.downloadStarterModel).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => {
      resolveDownload('/models/starter.gguf');
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(wizardMocks.startAndBindLocalEngine).toHaveBeenCalledWith(
      '/models/starter.gguf',
      'gguf',
      'Starter Model',
    ));
    expect(wizardMocks.notifyLocalModelStateChanged).toHaveBeenCalledTimes(1);
  });
});
