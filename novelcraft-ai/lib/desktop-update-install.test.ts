import { describe, expect, it, vi } from 'vitest';

import { installDesktopUpdate } from '@/lib/desktop-update-install';

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
