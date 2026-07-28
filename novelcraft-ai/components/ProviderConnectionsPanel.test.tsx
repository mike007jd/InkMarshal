// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true),
  runtimeHealth: vi.fn(),
  getConnections: vi.fn(() => []),
  getConnectionSecret: vi.fn(async () => null),
  removeConnection: vi.fn(),
  saveConnectionWithOptionalSecret: vi.fn(),
  subscribeConnectionsStore: vi.fn(() => () => {}),
  secretStoreActiveBackend: vi.fn(async (): Promise<'keychain' | 'encrypted_file'> => 'keychain'),
}));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: mocks.isTauriRuntime,
  runtimeHealth: mocks.runtimeHealth,
}));

vi.mock('@/lib/model-supply/connections', () => ({
  getConnections: mocks.getConnections,
  getConnectionSecret: mocks.getConnectionSecret,
  removeConnection: mocks.removeConnection,
  saveConnectionWithOptionalSecret: mocks.saveConnectionWithOptionalSecret,
  subscribeConnectionsStore: mocks.subscribeConnectionsStore,
}));

vi.mock('@/lib/model-supply/secret-store', () => ({
  secretStoreActiveBackend: mocks.secretStoreActiveBackend,
}));

import { LocaleProvider } from '@/components/LanguageProvider';
import { ProviderConnectionsPanel } from '@/components/ProviderConnectionsPanel';
import { getTranslations } from '@/lib/i18n';

const t = getTranslations('en');

function renderPanel() {
  return render(
    <LocaleProvider>
      <ProviderConnectionsPanel />
    </LocaleProvider>,
  );
}

async function expandPanel() {
  fireEvent.click(screen.getByText(t.providerConnectionsTitle));
  await waitFor(() => {
    expect(screen.getByText(t.modelManagerConnectionsEmpty)).toBeTruthy();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauriRuntime.mockReturnValue(true);
  mocks.getConnections.mockReturnValue([]);
  mocks.secretStoreActiveBackend.mockResolvedValue('keychain');
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: 'en',
  });
});

afterEach(() => {
  cleanup();
});

describe('ProviderConnectionsPanel secret backend disclosure', () => {
  it('discloses the system keychain backend with matching recovery guidance', async () => {
    mocks.secretStoreActiveBackend.mockResolvedValue('keychain');
    renderPanel();
    await expandPanel();

    await waitFor(() => {
      expect(screen.getByTestId('secret-backend-disclosure').textContent).toContain(
        t.secretStorageKeychain,
      );
    });
    expect(screen.getByTestId('secret-backend-disclosure').textContent).not.toContain(
      'AES-256-GCM',
    );
  });

  it('discloses the encrypted local fallback accurately (AES-256-GCM, not keychain, no path)', async () => {
    mocks.secretStoreActiveBackend.mockResolvedValue('encrypted_file');
    renderPanel();
    await expandPanel();

    await waitFor(() => {
      expect(screen.getByTestId('secret-backend-disclosure').textContent).toContain(
        'AES-256-GCM',
      );
    });
    const text = screen.getByTestId('secret-backend-disclosure').textContent ?? '';
    expect(text).toContain(t.secretStorageEncryptedFile);
    expect(text).not.toMatch(/plaintext|plain text/i);
    expect(text).not.toContain('/');
  });

  it('degrades to an honest unknown line when the probe fails', async () => {
    mocks.secretStoreActiveBackend.mockRejectedValue(new Error('probe exploded'));
    renderPanel();
    await expandPanel();

    await waitFor(() => {
      expect(screen.getByTestId('secret-backend-disclosure').textContent).toContain(
        t.secretStorageUnknown,
      );
    });
  });

  it('shows no disclosure off-desktop', async () => {
    mocks.isTauriRuntime.mockReturnValue(false);
    renderPanel();
    await expandPanel();

    expect(screen.queryByTestId('secret-backend-disclosure')).toBeNull();
    expect(mocks.secretStoreActiveBackend).not.toHaveBeenCalled();
  });
});

describe('ProviderConnectionsPanel connection test failures', () => {
  it('renders localized category copy, never the raw backend message', async () => {
    const rawRust =
      'Could not reach the runtime: connection refused — is the service running?';
    mocks.runtimeHealth.mockResolvedValue({
      reachable: false,
      transportOk: false,
      models: [],
      latencyMs: 0,
      message: rawRust,
    });

    renderPanel();
    await expandPanel();
    fireEvent.click(screen.getByText(t.modelManagerAddConnection));

    fireEvent.change(screen.getByPlaceholderText(t.modelManagerConnectionLabelPlaceholder), {
      target: { value: 'My provider' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
      target: { value: 'http://127.0.0.1:1234/v1' },
    });
    fireEvent.click(screen.getByText(t.modelManagerTestConnection));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(t.runtimeHealthUnreachable);
    });
    expect(screen.queryByText(/connection refused/)).toBeNull();
    expect(screen.queryByText(new RegExp(rawRust.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeNull();
  });

  it('maps a throwing probe to the localized probe-failed copy', async () => {
    mocks.runtimeHealth.mockRejectedValue(new Error('socket hang up 127.0.0.1:1234'));

    renderPanel();
    await expandPanel();
    fireEvent.click(screen.getByText(t.modelManagerAddConnection));

    fireEvent.change(screen.getByPlaceholderText(t.modelManagerConnectionLabelPlaceholder), {
      target: { value: 'My provider' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
      target: { value: 'http://127.0.0.1:1234/v1' },
    });
    fireEvent.click(screen.getByText(t.modelManagerTestConnection));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(t.runtimeHealthProbeFailed);
    });
    expect(screen.queryByText(/socket hang up/)).toBeNull();
  });
});
