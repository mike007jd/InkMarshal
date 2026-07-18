// ED-01 / D5 regression: the beforeunload keepalive PATCH must clear the dirty
// buffer ONLY on a 2xx response. `fetch` resolves for any HTTP status — a 409
// (optimistic-concurrency version conflict) or 5xx resolves, not rejects — so
// treating a resolved promise as success would clear the dirty buffer on a
// 409/500 and silently drop the user's unsaved edits (the localStorage
// draft-recovery layer discards a version-mismatched draft as stale).
//
// This exercises the real HTTP-outcome contract with a mocked fetch instead of
// the previous source-shape guard.

import { describe, expect, it, vi } from 'vitest';
import { performKeepaliveChapterSave } from '@/hooks/keepalive-chapter-save';

function run(fetchImpl: typeof fetch) {
  let dirtyCleared = false;
  let settled = false;
  const done = performKeepaliveChapterSave(
    fetchImpl,
    '/api/novels/n1/chapters/3',
    JSON.stringify({ content: 'body', version: 2 }),
    () => {
      dirtyCleared = true;
    },
    () => {
      settled = true;
    },
  );
  return { done, state: () => ({ dirtyCleared, settled }) };
}

describe('performKeepaliveChapterSave — HTTP outcome contract', () => {
  it('clears the dirty buffer on 200 and issues a keepalive PATCH', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const { done, state } = run(fetchImpl);
    await done;
    expect(state()).toEqual({ dirtyCleared: true, settled: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/novels/n1/chapters/3',
      expect.objectContaining({ method: 'PATCH', keepalive: true }),
    );
  });

  it('does NOT clear the dirty buffer on 409 (version conflict) but releases the claim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));
    const { done, state } = run(fetchImpl);
    await done;
    expect(state()).toEqual({ dirtyCleared: false, settled: true });
  });

  it('does NOT clear the dirty buffer on 500 but releases the claim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const { done, state } = run(fetchImpl);
    await done;
    expect(state()).toEqual({ dirtyCleared: false, settled: true });
  });

  it('does NOT clear the dirty buffer on a network-level reject but releases the claim', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const { done, state } = run(fetchImpl);
    await done;
    expect(state()).toEqual({ dirtyCleared: false, settled: true });
  });

  it('never rejects even when fetch throws synchronously (unload safety)', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('sync throw');
    }) as unknown as typeof fetch;
    const { done, state } = run(fetchImpl);
    await expect(done).resolves.toBeUndefined();
    expect(state()).toEqual({ dirtyCleared: false, settled: true });
  });
});
