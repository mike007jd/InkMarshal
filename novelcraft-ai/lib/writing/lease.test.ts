import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  releaseWritingLock: vi.fn(async () => undefined),
  renewWritingLock: vi.fn(),
}));

vi.mock('@/lib/db', () => db);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createWritingLease', () => {
  it('marks a confirmed timer renewal miss as lock loss and notifies once', async () => {
    db.renewWritingLock.mockResolvedValue(null);
    const { createWritingLease } = await import('@/lib/writing/lease');
    const onLost = vi.fn();
    const lease = createWritingLease('novel', 'token', vi.fn());

    await lease.renewQuietly(onLost);

    expect(lease.hasLost()).toBe(true);
    expect(onLost).toHaveBeenCalledOnce();
  });

  it('reports a transient renewal error without misclassifying it as lost', async () => {
    db.renewWritingLock.mockRejectedValue(new Error('sqlite busy'));
    const { createWritingLease } = await import('@/lib/writing/lease');
    const log = vi.fn();
    const onLost = vi.fn();
    const lease = createWritingLease('novel', 'token', log);

    await lease.renewQuietly(onLost);

    expect(lease.hasLost()).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      reason: 'lock_renewal_error',
      message: 'sqlite busy',
    }));
  });
});
