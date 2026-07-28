// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  requestVaultPathChanged,
  subscribeVaultPathChanged,
} from '@/lib/vault/runtime-events';

describe('vault path change acknowledgement', () => {
  let unsubscribe: (() => void) | null = null;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  it('resolves only after the coordinator finishes the requested sync', async () => {
    let finish!: () => void;
    const onChange = vi.fn(() => new Promise<void>(resolve => {
      finish = resolve;
    }));
    unsubscribe = subscribeVaultPathChanged(onChange);

    let settled = false;
    const request = requestVaultPathChanged('novel-1', '/vault/new')
      .then(() => { settled = true; });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({
      novelId: 'novel-1',
      vaultPath: '/vault/new',
    }));
    expect(settled).toBe(false);

    finish();
    await request;
    expect(settled).toBe(true);
  });

  it('propagates coordinator failures and rejects when no coordinator is mounted', async () => {
    unsubscribe = subscribeVaultPathChanged(async () => {
      throw new Error('snapshot failed');
    });
    await expect(requestVaultPathChanged('novel-1', '/vault/new'))
      .rejects.toThrow('snapshot failed');

    unsubscribe();
    unsubscribe = null;
    await expect(requestVaultPathChanged('novel-1', '/vault/other'))
      .rejects.toThrow('coordinator is unavailable');
  });
});
