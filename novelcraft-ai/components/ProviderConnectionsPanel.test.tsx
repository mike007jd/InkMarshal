// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CapabilityProfile, RuntimeConnection } from '@/lib/model-supply/types';

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true),
  runtimeHealth: vi.fn(),
  getConnections: vi.fn((): RuntimeConnection[] => []),
  getConnection: vi.fn((_id: string): RuntimeConnection | null => null),
  getCapabilityProfile: vi.fn((): CapabilityProfile => ({
    draft: null,
    rewrite: null,
    planning: null,
    recall: null,
  })),
  getConnectionSecret: vi.fn(async (_id: string): Promise<string | null> => null),
  getConnectionSecretForSnapshot: vi.fn(async () => null),
  removeConnection: vi.fn(async () => undefined),
  saveConnectionWithOptionalSecret: vi.fn(),
  saveCapabilityBindingsDurable: vi.fn(async (): Promise<CapabilityProfile> => ({
    draft: null,
    rewrite: null,
    planning: null,
    recall: null,
  })),
  subscribeConnectionsStore: vi.fn(() => () => {}),
  secretStoreActiveBackend: vi.fn(async (): Promise<'keychain' | 'encrypted_file'> => 'keychain'),
  connectProviderWithRealProbe: vi.fn(),
}));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: mocks.isTauriRuntime,
  runtimeHealth: mocks.runtimeHealth,
}));

vi.mock('@/lib/model-supply/connections', () => ({
  getConnections: mocks.getConnections,
  getConnection: mocks.getConnection,
  getCapabilityProfile: mocks.getCapabilityProfile,
  getConnectionSecret: mocks.getConnectionSecret,
  getConnectionSecretForSnapshot: mocks.getConnectionSecretForSnapshot,
  removeConnection: mocks.removeConnection,
  saveConnectionWithOptionalSecret: mocks.saveConnectionWithOptionalSecret,
  saveCapabilityBindingsDurable: mocks.saveCapabilityBindingsDurable,
  subscribeConnectionsStore: mocks.subscribeConnectionsStore,
}));

vi.mock('@/lib/model-supply/secret-store', () => ({
  secretStoreActiveBackend: mocks.secretStoreActiveBackend,
}));

vi.mock('@/lib/model-supply/curated-connect', async () => {
  const actual = await vi.importActual<typeof import('@/lib/model-supply/curated-connect')>(
    '@/lib/model-supply/curated-connect',
  );
  return {
    ...actual,
    connectProviderWithRealProbe: mocks.connectProviderWithRealProbe,
  };
});

import { LocaleProvider } from '@/components/LanguageProvider';
import { ProviderConnectionsPanel } from '@/components/ProviderConnectionsPanel';
import { getTranslations } from '@/lib/i18n';
import {
  KIMI_CODE_BASE_URL,
  KIMI_CODE_HIGHSPEED_MODEL,
} from '@/lib/providers';

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

async function openAddDialog() {
  fireEvent.click(screen.getByText(t.modelManagerAddConnection));
  await waitFor(() => {
    expect(screen.getByText(t.providerDirectoryLabel)).toBeTruthy();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isTauriRuntime.mockReturnValue(true);
  mocks.getConnections.mockReturnValue([]);
  mocks.getConnectionSecret.mockResolvedValue(null);
  mocks.getCapabilityProfile.mockReturnValue({
    draft: null,
    rewrite: null,
    planning: null,
    recall: null,
  });
  mocks.secretStoreActiveBackend.mockResolvedValue('keychain');
  mocks.connectProviderWithRealProbe.mockReset();
  global.fetch = vi.fn();
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: 'en',
  });
  // Radix Select scrolls the highlighted option into view.
  Element.prototype.scrollIntoView = () => undefined;
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

describe('ProviderConnectionsPanel key-first curated setup', () => {
  async function selectProviderDirectory(optionName: string) {
    fireEvent.click(screen.getByTestId('provider-directory-select'));
    fireEvent.click(await screen.findByRole('option', { name: optionName }));
  }

  it('simplifies curated fields to key-first for Kimi Code HighSpeed', async () => {
    renderPanel();
    await expandPanel();
    await openAddDialog();

    await selectProviderDirectory(t.providerNameKimiCode);

    await waitFor(() => {
      expect(screen.getByTestId('key-first-hint')).toBeTruthy();
    });
    expect(screen.queryByPlaceholderText(t.modelManagerConnectionLabelPlaceholder)).toBeNull();
    expect(screen.queryByPlaceholderText('https://api.openai.com/v1')).toBeNull();
    expect(screen.queryByTestId('connection-model-input')).toBeNull();
    expect(screen.getByTestId('connect-and-use')).toBeTruthy();
    expect(screen.getByText(t.modelManagerConnectAndUse)).toBeTruthy();
  });

  it('uses the same key-first flow and catalog transport for Anthropic', async () => {
    mocks.connectProviderWithRealProbe.mockResolvedValue({
      ok: false,
      category: 'invalid-credentials',
      saved: false,
    });
    renderPanel();
    await expandPanel();
    await openAddDialog();

    await selectProviderDirectory(t.providerNameAnthropic);

    expect(screen.getByTestId('key-first-hint')).toBeTruthy();
    expect(screen.queryByPlaceholderText(t.modelManagerConnectionLabelPlaceholder)).toBeNull();
    expect(screen.queryByPlaceholderText('https://api.openai.com/v1')).toBeNull();
    expect(screen.queryByTestId('connection-model-input')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(t.modelManagerConnectionApiKey), {
      target: { value: 'anthropic-test-key' },
    });
    fireEvent.click(screen.getByTestId('connect-and-use'));

    await waitFor(() => expect(mocks.connectProviderWithRealProbe).toHaveBeenCalled());
    expect(mocks.connectProviderWithRealProbe.mock.calls[0]?.[0]).toMatchObject({
      kind: 'provider',
      transport: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      modelId: 'claude-sonnet-5',
    });
  });

  it('keeps technical fields hidden when a curated provider needs only a model id', async () => {
    renderPanel();
    await expandPanel();
    await openAddDialog();

    await selectProviderDirectory(t.providerNameVolcengine);

    expect(screen.getByTestId('key-first-hint')).toBeTruthy();
    expect(screen.queryByPlaceholderText(t.modelManagerConnectionLabelPlaceholder)).toBeNull();
    expect(screen.queryByPlaceholderText('https://api.openai.com/v1')).toBeNull();
    expect(screen.getByTestId('connection-model-input')).toBeTruthy();
  });

  it('keeps custom endpoint advanced and requires a model for success', async () => {
    renderPanel();
    await expandPanel();
    await openAddDialog();

    expect(screen.getByPlaceholderText(t.modelManagerConnectionLabelPlaceholder)).toBeTruthy();
    expect(screen.getByPlaceholderText('https://api.openai.com/v1')).toBeTruthy();
    expect(screen.getByTestId('connection-model-input')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(t.modelManagerConnectionLabelPlaceholder), {
      target: { value: 'My custom' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
      target: { value: 'https://llm.example.com/v1' },
    });

    // Without a model, Test/Connect cannot report success.
    expect(
      (screen.getByText(t.modelManagerTestConnection).closest('button') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByTestId('connect-and-use') as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.runtimeHealth).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('ProviderConnectionsPanel existing connection verification', () => {
  it('prefills a bound model so an existing connection can run the real test', async () => {
    const connection = {
      id: 'existing-1',
      label: 'Existing provider',
      kind: 'provider' as const,
      transport: 'openai-compatible' as const,
      baseUrl: 'https://llm.example.com/v1',
      secretRef: { account: 'connection:existing-1' },
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    mocks.getConnections.mockReturnValue([connection]);
    mocks.getConnectionSecret.mockResolvedValue('stored-secret');
    mocks.getCapabilityProfile.mockReturnValue({
      draft: { connectionId: connection.id, modelId: 'bound-model' },
      rewrite: null,
      planning: null,
      recall: null,
    });

    renderPanel();
    fireEvent.click(screen.getByText(t.providerConnectionsTitle));
    fireEvent.click(await screen.findByText(t.edit));

    const modelInput = await screen.findByTestId('connection-model-input');
    expect((modelInput as HTMLInputElement).value).toBe('bound-model');
    expect(
      (screen.getByText(t.modelManagerTestConnection).closest('button') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
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
    await openAddDialog();

    fireEvent.change(screen.getByPlaceholderText(t.modelManagerConnectionLabelPlaceholder), {
      target: { value: 'My provider' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
      target: { value: 'http://127.0.0.1:1234/v1' },
    });
    fireEvent.change(screen.getByTestId('connection-model-input'), {
      target: { value: 'local-model' },
    });
    fireEvent.click(screen.getByText(t.modelManagerTestConnection));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(t.runtimeHealthUnreachable);
    });
    expect(screen.queryByText(/connection refused/)).toBeNull();
    expect(screen.queryByText(new RegExp(rawRust.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeNull();
    expect(mocks.saveConnectionWithOptionalSecret).not.toHaveBeenCalled();
  });

  it('maps a throwing probe to the localized probe-failed copy', async () => {
    mocks.runtimeHealth.mockRejectedValue(new Error('socket hang up 127.0.0.1:1234'));

    renderPanel();
    await expandPanel();
    await openAddDialog();

    fireEvent.change(screen.getByPlaceholderText(t.modelManagerConnectionLabelPlaceholder), {
      target: { value: 'My provider' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
      target: { value: 'http://127.0.0.1:1234/v1' },
    });
    fireEvent.change(screen.getByTestId('connection-model-input'), {
      target: { value: 'local-model' },
    });
    fireEvent.click(screen.getByText(t.modelManagerTestConnection));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(t.runtimeHealthProbeFailed);
    });
    expect(screen.queryByText(/socket hang up/)).toBeNull();
    expect(mocks.saveConnectionWithOptionalSecret).not.toHaveBeenCalled();
  });

  it('does not report test success without a real nonblank generation', async () => {
    mocks.runtimeHealth.mockResolvedValue({
      reachable: true,
      transportOk: true,
      models: ['local-model'],
      latencyMs: 12,
      message: 'ok',
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, category: 'empty-generation' }),
    });

    renderPanel();
    await expandPanel();
    await openAddDialog();

    fireEvent.change(screen.getByPlaceholderText(t.modelManagerConnectionLabelPlaceholder), {
      target: { value: 'My provider' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://api.openai.com/v1'), {
      target: { value: 'http://127.0.0.1:1234/v1' },
    });
    fireEvent.change(screen.getByTestId('connection-model-input'), {
      target: { value: 'local-model' },
    });
    fireEvent.click(screen.getByText(t.modelManagerTestConnection));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(
        t.modelManagerProbeEmptyGeneration,
      );
    });
    expect(screen.getByRole('status').textContent).not.toContain(t.modelManagerTestReachable);
    expect(mocks.saveConnectionWithOptionalSecret).not.toHaveBeenCalled();
  });
});

describe('ProviderConnectionsPanel connect-and-use', () => {
  it('does not persist a secret when connect fails', async () => {
    // Panel uses the mocked connect helper.
    mocks.connectProviderWithRealProbe.mockResolvedValue({
      ok: false,
      category: 'invalid-credentials',
      saved: false,
    });

    renderPanel();
    await expandPanel();
    await openAddDialog();

    fireEvent.click(screen.getByTestId('provider-directory-select'));
    fireEvent.click(await screen.findByRole('option', { name: t.providerNameKimiCode }));

    const keyInput = screen.getByPlaceholderText(t.modelManagerConnectionApiKey);
    fireEvent.change(keyInput, { target: { value: 'sk-bad' } });
    fireEvent.click(screen.getByTestId('connect-and-use'));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain(
        t.modelManagerProbeInvalidCredentials,
      );
    });
    expect(mocks.saveConnectionWithOptionalSecret).not.toHaveBeenCalled();
    expect(mocks.saveCapabilityBindingsDurable).not.toHaveBeenCalled();
  });

  it('shows user-safe plan-restricted copy without HTTP/temperature detail', async () => {
    mocks.connectProviderWithRealProbe.mockResolvedValue({
      ok: false,
      category: 'plan-restricted',
      saved: false,
    });

    renderPanel();
    await expandPanel();
    await openAddDialog();
    fireEvent.click(screen.getByTestId('provider-directory-select'));
    fireEvent.click(await screen.findByRole('option', { name: t.providerNameKimiCode }));
    fireEvent.change(screen.getByPlaceholderText(t.modelManagerConnectionApiKey), {
      target: { value: 'sk-plan' },
    });
    fireEvent.click(screen.getByTestId('connect-and-use'));

    await waitFor(() => {
      const status = screen.getByRole('status');
      expect(status.textContent).toContain(t.modelManagerProbePlanRestricted);
      expect(status.textContent).not.toMatch(/400|401|temperature/i);
    });
  });

  it('reports success after connect-and-use resolves', async () => {
    mocks.connectProviderWithRealProbe.mockResolvedValue({
      ok: true,
      connection: {
        id: 'c-new',
        label: t.providerNameKimiCode,
        kind: 'provider',
        transport: 'openai-compatible',
        baseUrl: KIMI_CODE_BASE_URL,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    });
    mocks.getConnections.mockReturnValue([]);

    renderPanel();
    await expandPanel();
    await openAddDialog();
    fireEvent.click(screen.getByTestId('provider-directory-select'));
    fireEvent.click(await screen.findByRole('option', { name: t.providerNameKimiCode }));
    fireEvent.change(screen.getByPlaceholderText(t.modelManagerConnectionApiKey), {
      target: { value: 'sk-good' },
    });
    fireEvent.click(screen.getByTestId('connect-and-use'));

    await waitFor(() => {
      expect(mocks.connectProviderWithRealProbe).toHaveBeenCalled();
    });
    const args = mocks.connectProviderWithRealProbe.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      baseUrl: KIMI_CODE_BASE_URL,
      modelId: KIMI_CODE_HIGHSPEED_MODEL,
      apiKey: 'sk-good',
      kind: 'provider',
      transport: 'openai-compatible',
    });
  });
});

describe('connectProviderWithRealProbe real implementation', () => {
  // Re-import actual for isolated unit coverage of save/bind/rollback.
  // The panel mock above only intercepts the named export for UI tests; call
  // through the hoisted mock's mockImplementation to exercise the real path.

  it('binds all four roles after successful health + generation', async () => {
    const actual = await vi.importActual<typeof import('@/lib/model-supply/curated-connect')>(
      '@/lib/model-supply/curated-connect',
    );
    mocks.saveConnectionWithOptionalSecret.mockResolvedValue({
      id: 'c1',
      label: 'Kimi Code HighSpeed',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: KIMI_CODE_BASE_URL,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    mocks.saveCapabilityBindingsDurable.mockResolvedValue({
      draft: { connectionId: 'c1', modelId: KIMI_CODE_HIGHSPEED_MODEL },
      rewrite: { connectionId: 'c1', modelId: KIMI_CODE_HIGHSPEED_MODEL },
      planning: { connectionId: 'c1', modelId: KIMI_CODE_HIGHSPEED_MODEL },
      recall: { connectionId: 'c1', modelId: KIMI_CODE_HIGHSPEED_MODEL },
    });

    const result = await actual.connectProviderWithRealProbe({
      label: 'Kimi Code HighSpeed',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: KIMI_CODE_BASE_URL,
      modelId: KIMI_CODE_HIGHSPEED_MODEL,
      apiKey: 'sk-good',
      checkHealth: async () => ({
        reachable: true,
        transportOk: true,
        models: [KIMI_CODE_HIGHSPEED_MODEL],
      }),
      runGenerationProbe: async () => ({ ok: true }),
    });

    expect(result.ok).toBe(true);
    expect(mocks.saveConnectionWithOptionalSecret).toHaveBeenCalledTimes(1);
    expect(mocks.saveCapabilityBindingsDurable).toHaveBeenCalledWith([
      { role: 'draft', connectionId: 'c1', modelId: KIMI_CODE_HIGHSPEED_MODEL },
      { role: 'rewrite', connectionId: 'c1', modelId: KIMI_CODE_HIGHSPEED_MODEL },
      { role: 'planning', connectionId: 'c1', modelId: KIMI_CODE_HIGHSPEED_MODEL },
      { role: 'recall', connectionId: 'c1', modelId: KIMI_CODE_HIGHSPEED_MODEL },
    ]);
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it('rolls back the new connection when binding fails', async () => {
    const actual = await vi.importActual<typeof import('@/lib/model-supply/curated-connect')>(
      '@/lib/model-supply/curated-connect',
    );
    mocks.saveConnectionWithOptionalSecret.mockResolvedValue({
      id: 'c-rollback',
      label: 'Kimi Code HighSpeed',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: KIMI_CODE_BASE_URL,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    mocks.saveCapabilityBindingsDurable.mockRejectedValue(new Error('profile write failed'));
    mocks.removeConnection.mockResolvedValue(undefined);

    const result = await actual.connectProviderWithRealProbe({
      label: 'Kimi Code HighSpeed',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: KIMI_CODE_BASE_URL,
      modelId: KIMI_CODE_HIGHSPEED_MODEL,
      apiKey: 'sk-good',
      checkHealth: async () => ({
        reachable: true,
        transportOk: true,
        models: [KIMI_CODE_HIGHSPEED_MODEL],
      }),
      runGenerationProbe: async () => ({ ok: true }),
    });

    expect(result).toEqual({ ok: false, category: 'bind-failed', saved: false });
    expect(mocks.removeConnection).toHaveBeenCalledWith('c-rollback');
  });

  it('reports a retained visible connection when compensation also fails', async () => {
    const actual = await vi.importActual<typeof import('@/lib/model-supply/curated-connect')>(
      '@/lib/model-supply/curated-connect',
    );
    const connection = {
      id: 'c-retained',
      label: 'Kimi Code HighSpeed',
      kind: 'provider' as const,
      transport: 'openai-compatible' as const,
      baseUrl: KIMI_CODE_BASE_URL,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    mocks.saveConnectionWithOptionalSecret.mockResolvedValue(connection);
    mocks.saveCapabilityBindingsDurable.mockRejectedValue(new Error('profile write failed'));
    mocks.removeConnection.mockRejectedValue(new Error('connection rollback failed'));

    const result = await actual.connectProviderWithRealProbe({
      label: connection.label,
      kind: connection.kind,
      transport: connection.transport,
      baseUrl: connection.baseUrl,
      modelId: KIMI_CODE_HIGHSPEED_MODEL,
      apiKey: 'sk-good',
      checkHealth: async () => ({
        reachable: true,
        transportOk: true,
        models: [KIMI_CODE_HIGHSPEED_MODEL],
      }),
      runGenerationProbe: async () => ({ ok: true }),
    });

    expect(result).toEqual({
      ok: false,
      category: 'rollback-failed',
      saved: true,
      connection,
    });
    expect(mocks.removeConnection).toHaveBeenCalledTimes(2);
  });

  it('saves nothing when generation fails before persist', async () => {
    const actual = await vi.importActual<typeof import('@/lib/model-supply/curated-connect')>(
      '@/lib/model-supply/curated-connect',
    );
    const result = await actual.connectProviderWithRealProbe({
      label: 'Kimi Code HighSpeed',
      kind: 'provider',
      transport: 'openai-compatible',
      baseUrl: KIMI_CODE_BASE_URL,
      modelId: KIMI_CODE_HIGHSPEED_MODEL,
      apiKey: 'sk-bad',
      checkHealth: async () => ({
        reachable: true,
        transportOk: true,
        models: [KIMI_CODE_HIGHSPEED_MODEL],
      }),
      runGenerationProbe: async () => ({ ok: false, category: 'invalid-credentials' }),
    });

    expect(result).toEqual({ ok: false, category: 'invalid-credentials', saved: false });
    expect(mocks.saveConnectionWithOptionalSecret).not.toHaveBeenCalled();
    expect(mocks.saveCapabilityBindingsDurable).not.toHaveBeenCalled();
  });
});
