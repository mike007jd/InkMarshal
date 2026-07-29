import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauriRuntime: vi.fn(() => true),
  runtimeHealth: vi.fn(),
  getConnectionSecret: vi.fn(),
}));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: mocks.isTauriRuntime,
  runtimeHealth: mocks.runtimeHealth,
}));

vi.mock('./connections', () => ({
  getConnectionSecret: mocks.getConnectionSecret,
}));

import { getTranslations } from '@/lib/i18n';
import { categorizeHealthFailure, healthFailureMessage } from './health-failure';
import { checkConnectionHealth } from './runtime-health';
import type { ConnectionHealth, RuntimeConnection } from './types';

function connection(): RuntimeConnection {
  return {
    id: 'c1',
    label: 'P',
    kind: 'provider',
    transport: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function health(overrides: Partial<ConnectionHealth>): ConnectionHealth {
  return {
    reachable: false,
    transportOk: false,
    models: [],
    latencyMs: 0,
    message: '',
    ...overrides,
  };
}

describe('categorizeHealthFailure', () => {
  it('maps an unanswered probe to unreachable', () => {
    expect(categorizeHealthFailure(health({ reachable: false }))).toBe('unreachable');
  });

  it('maps an answered but unverified probe without guessing the cause', () => {
    expect(
      categorizeHealthFailure(health({ reachable: true, transportOk: false })),
    ).toBe('verification-failed');
  });

  it('honors the client-set failure kinds before the flags', () => {
    expect(
      categorizeHealthFailure(health({ failureKind: 'desktop-required' })),
    ).toBe('desktop-required');
    expect(
      categorizeHealthFailure(health({ reachable: true, failureKind: 'probe-failed' })),
    ).toBe('probe-failed');
  });
});

describe('healthFailureMessage', () => {
  it('localizes every category in en / zh-CN / zh-TW without raw backend text', () => {
    const rawRust =
      'Could not reach the runtime: connection refused — is the service running?';
    for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
      const t = getTranslations(locale);
      for (const category of [
        'desktop-required',
        'unreachable',
        'verification-failed',
        'probe-failed',
      ] as const) {
        const message = healthFailureMessage(category, t);
        expect(message.length).toBeGreaterThan(0);
        expect(message).not.toContain(rawRust);
        expect(message).not.toContain('connection refused');
      }
    }
  });

  it('gives Chinese users Chinese copy for the unreachable category', () => {
    expect(healthFailureMessage('unreachable', getTranslations('zh-CN'))).toBe(
      '无法连接该服务。请确认它正在运行且地址正确，然后重试。',
    );
    expect(healthFailureMessage('unreachable', getTranslations('zh-TW'))).toBe(
      '無法連線該服務。請確認它正在執行且地址正確，然後重試。',
    );
  });
});

describe('checkConnectionHealth failure kinds', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.isTauriRuntime.mockReturnValue(true);
  });

  it('marks off-desktop results as desktop-required', async () => {
    mocks.isTauriRuntime.mockReturnValue(false);
    const result = await checkConnectionHealth(connection());
    expect(categorizeHealthFailure(result)).toBe('desktop-required');
  });

  it('marks a throwing probe as probe-failed and keeps raw detail out of the flags', async () => {
    mocks.runtimeHealth.mockRejectedValue(new Error('connection refused'));
    const result = await checkConnectionHealth(connection());
    expect(categorizeHealthFailure(result)).toBe('probe-failed');
  });
});
