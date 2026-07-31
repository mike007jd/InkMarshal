/** @vitest-environment jsdom */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DESKTOP_UPDATE_MANUAL_CHECK_EVENT } from '@/lib/desktop-update-preferences';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  openExternal: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: () => true,
  openExternal: mocks.openExternal,
}));
vi.mock('@/components/LanguageProvider', () => ({
  useLanguage: () => ({
    t: {
      updateAvailableTitle: 'Update available',
      updateCriticalTitle: 'Critical update',
      updateVersion: 'Version {version}',
      updateInstalling: 'Installing',
      updateProgress: '{progress}%',
      updateVerifiedDmgRecoveryHint: 'Use the verified DMG.',
      updateDownloadVerifiedDmg: 'Download DMG',
      updateRetry: 'Retry',
      updateInstall: 'Install',
      updateLater: 'Later',
      updateSaveFailed: 'Save failed',
      updateInstallFailed: 'Install failed',
      updateInstallCorruptPackage: 'Corrupt package',
      updateInstallNetworkFailed: 'Network failed',
      updateInstallPermissionFailed: 'Permission failed',
    },
  }),
}));

import { DesktopUpdateCoordinator } from '@/components/DesktopUpdateCoordinator';

describe('DesktopUpdateCoordinator update resource lifecycle', () => {
  beforeEach(() => {
    mocks.check.mockReset();
    mocks.openExternal.mockReset();
  });

  it('closes and clears a previously offered update when a later check returns null', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.check
      .mockResolvedValueOnce({ version: '0.1.5', body: '', rawJson: {}, close })
      .mockResolvedValueOnce(null);

    render(<DesktopUpdateCoordinator />);

    await act(async () => {
      window.dispatchEvent(new Event(DESKTOP_UPDATE_MANUAL_CHECK_EVENT));
    });
    expect(await screen.findByText('Version 0.1.5')).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new Event(DESKTOP_UPDATE_MANUAL_CHECK_EVENT));
    });

    await waitFor(() => expect(screen.queryByText('Version 0.1.5')).toBeNull());
    expect(close).toHaveBeenCalledTimes(1);
  });
});
