// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getBindingForRole: vi.fn(),
  getConnection: vi.fn(),
  subscribeConnectionsStore: vi.fn(() => () => {}),
}));

vi.mock('@/lib/model-supply/connections', () => ({
  getBindingForRole: mocks.getBindingForRole,
  getConnection: mocks.getConnection,
  subscribeConnectionsStore: mocks.subscribeConnectionsStore,
}));

import { LocaleProvider } from '@/components/LanguageProvider';
import { CreativityPicker } from './CreativityPicker';
import { getTranslations } from '@/lib/i18n';
import { KIMI_CODE_BASE_URL } from '@/lib/providers';

const t = getTranslations('en');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBindingForRole.mockImplementation((role: string) => (
    role === 'rewrite'
      ? { connectionId: 'kimi', modelId: 'kimi-for-coding-highspeed' }
      : null
  ));
  mocks.getConnection.mockReturnValue({
    id: 'kimi',
    label: 'Kimi Code HighSpeed',
    kind: 'provider',
    transport: 'openai-compatible',
    baseUrl: KIMI_CODE_BASE_URL,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
});

afterEach(cleanup);

describe('CreativityPicker fixed-sampling UX', () => {
  it('shows automatic optimization only for the role bound to a fixed model', () => {
    const { rerender } = render(
      <LocaleProvider>
        <CreativityPicker value="balanced" onChange={vi.fn()} role="rewrite" />
      </LocaleProvider>,
    );

    expect(screen.getByTestId('creativity-picker-automatic')).toBeTruthy();
    expect(screen.getByText(t.creativityAutomatic)).toBeTruthy();

    rerender(
      <LocaleProvider>
        <CreativityPicker value="balanced" onChange={vi.fn()} role="draft" />
      </LocaleProvider>,
    );

    expect(screen.getByTestId('creativity-picker')).toBeTruthy();
    expect(screen.queryByText(t.creativityAutomatic)).toBeNull();
  });
});
