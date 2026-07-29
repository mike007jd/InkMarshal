// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getDesktopStatus: vi.fn(async () => ({ desktop: true, platform: 'macos' })),
  engineStatus: vi.fn(async () => []),
  getConnections: vi.fn(() => [
    {
      id: 'conn-1',
      label: 'My provider',
      kind: 'provider' as const,
      transport: 'openai-compatible' as const,
      baseUrl: 'http://127.0.0.1:1234/v1',
      secretRef: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]),
  subscribeConnectionsStore: vi.fn(() => () => {}),
  checkConnectionHealth: vi.fn(),
}));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: () => false,
  getDesktopStatus: mocks.getDesktopStatus,
  engineStatus: mocks.engineStatus,
}));

vi.mock('@/lib/model-supply/connections', () => ({
  getConnections: mocks.getConnections,
  subscribeConnectionsStore: mocks.subscribeConnectionsStore,
}));

vi.mock('@/lib/model-supply/runtime-health', () => ({
  checkConnectionHealth: mocks.checkConnectionHealth,
}));

import { LocaleProvider } from '@/components/LanguageProvider';
import { ConnectionHealthPanel } from '@/components/ConnectionHealthPanel';
import { getTranslations } from '@/lib/i18n';

const t = getTranslations('en');

function renderPanel() {
  return render(
    <LocaleProvider>
      <ConnectionHealthPanel />
    </LocaleProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: 'en',
  });
});

afterEach(() => {
  cleanup();
});

describe('ConnectionHealthPanel failure rendering', () => {
  it('renders localized unreachable copy instead of the raw Rust message', async () => {
    mocks.checkConnectionHealth.mockResolvedValue({
      reachable: false,
      transportOk: false,
      models: [],
      latencyMs: 0,
      message:
        'Could not reach the runtime: connection refused — is the service running?',
    });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(t.runtimeHealthUnreachable)).toBeTruthy();
    });
    expect(screen.queryByText(/connection refused/)).toBeNull();
  });

  it('renders verification-failed copy when the service answers but cannot be verified', async () => {
    mocks.checkConnectionHealth.mockResolvedValue({
      reachable: true,
      transportOk: false,
      models: [],
      latencyMs: 5,
      message: 'unexpected response shape from http://127.0.0.1:1234/v1/chat',
    });
    renderPanel();

    await waitFor(() => {
      expect(screen.getByText(t.runtimeHealthVerificationFailed)).toBeTruthy();
    });
    expect(screen.queryByText(/unexpected response shape/)).toBeNull();
  });

  it('keeps the healthy path unchanged', async () => {
    mocks.checkConnectionHealth.mockResolvedValue({
      reachable: true,
      transportOk: true,
      models: ['model-a'],
      latencyMs: 12,
      message: 'Reachable, 1 model(s)',
    });
    renderPanel();

    await waitFor(() => {
      expect(screen.getAllByText(t.desktopRuntimeReady).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(t.runtimeHealthUnreachable)).toBeNull();
  });
});
