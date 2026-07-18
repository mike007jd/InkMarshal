import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStartWritingLogger, shouldFinalizeStartWriting, START_WRITING_EVENTS } from '@/lib/start-writing-logging';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('shouldFinalizeStartWriting', () => {
  it('finalizes only successful full-book and terminal error paths', () => {
    expect(shouldFinalizeStartWriting('complete')).toBe(true);
    expect(shouldFinalizeStartWriting('error')).toBe(true);
    expect(shouldFinalizeStartWriting('unknown')).toBe(true);

    expect(shouldFinalizeStartWriting('batch_complete')).toBe(false);
    expect(shouldFinalizeStartWriting('aborted')).toBe(false);
    expect(shouldFinalizeStartWriting('controller_closed')).toBe(false);
    expect(shouldFinalizeStartWriting('lock_failed')).toBe(false);
  });
});

describe('createStartWritingLogger', () => {
  it('keeps key start-writing events visible in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('START_WRITING_DEBUG', '');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    const log = createStartWritingLogger('novel-1');
    log(START_WRITING_EVENTS.lockRenewed, { ttl: 60 });
    log(START_WRITING_EVENTS.begin, { stage: 'ready_for_greenlight' });
    log(START_WRITING_EVENTS.end, { reason: 'aborted' });

    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0]?.[0]).toContain('begin');
    expect(info.mock.calls[1]?.[0]).toContain('end');
  });
});
