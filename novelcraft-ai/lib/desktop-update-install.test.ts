import { describe, expect, it, vi } from 'vitest';

import {
  VERIFIED_MAC_DMG_DOWNLOAD_URL,
  categorizeDesktopUpdateFailure,
  desktopUpdateFailureMessage,
  installDesktopUpdate,
} from '@/lib/desktop-update-install';

const t = {
  updateInstallFailed: 'generic-failure',
  updateInstallCorruptPackage: 'corrupt-failure',
  updateInstallNetworkFailed: 'network-failure',
  updateInstallPermissionFailed: 'permission-failure',
  updateSaveFailed: 'save-failed',
};

describe('installDesktopUpdate', () => {
  it('downloads, durably flushes, installs, and only then relaunches', async () => {
    const calls: string[] = [];
    const update = {
      download: vi.fn(async () => { calls.push('download'); }),
      install: vi.fn(async () => { calls.push('install'); }),
    };

    await installDesktopUpdate({
      update,
      flush: async () => { calls.push('flush'); return { ok: true }; },
      relaunch: async () => { calls.push('relaunch'); },
      saveFailedMessage: 'save failed',
    });

    expect(calls).toEqual(['download', 'flush', 'install', 'relaunch']);
  });

  it('does not install or relaunch when the durable flush fails', async () => {
    const update = {
      download: vi.fn(async () => undefined),
      install: vi.fn(async () => undefined),
    };
    const relaunch = vi.fn(async () => undefined);

    await expect(installDesktopUpdate({
      update,
      flush: async () => ({ ok: false }),
      relaunch,
      saveFailedMessage: 'save failed',
    })).rejects.toThrow('save failed');

    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe('categorizeDesktopUpdateFailure', () => {
  it('maps AppleDouble unpack strings without exposing local paths', () => {
    const raw =
      'failed to unpack `._InkMarshal.app` into /var/folders/xx/tauri_updated_appABC/ directory';
    expect(categorizeDesktopUpdateFailure(raw)).toBe('corrupt-package');
    expect(categorizeDesktopUpdateFailure(new Error(raw))).toBe('corrupt-package');
    const message = desktopUpdateFailureMessage('corrupt-package', t);
    expect(message).toBe('corrupt-failure');
    expect(message).not.toContain('/var/folders');
    expect(message).not.toContain('._InkMarshal.app');
  });

  it('categorizes network, permission, save-failed, and generic failures', () => {
    expect(categorizeDesktopUpdateFailure('Could not fetch a valid release JSON from the remote')).toBe(
      'network',
    );
    expect(categorizeDesktopUpdateFailure('Permission denied (os error 13)')).toBe('permission');
    expect(categorizeDesktopUpdateFailure(new Error('save-failed'), 'save-failed')).toBe('save-failed');
    expect(categorizeDesktopUpdateFailure('something unexpected')).toBe('generic');
    expect(desktopUpdateFailureMessage('network', t)).toBe('network-failure');
    expect(desktopUpdateFailureMessage('permission', t)).toBe('permission-failure');
    expect(desktopUpdateFailureMessage('generic', t)).toBe('generic-failure');
  });

  it('pins the verified DMG recovery URL', () => {
    expect(VERIFIED_MAC_DMG_DOWNLOAD_URL).toBe(
      'https://github.com/mike007jd/InkMarshal/releases/latest/download/InkMarshal-mac-aarch64.dmg',
    );
  });
});
