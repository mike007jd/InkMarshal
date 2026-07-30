import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';

const requestContext = vi.hoisted(() => ({
  headers: vi.fn(),
  cookies: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/headers', () => ({
  headers: requestContext.headers,
  cookies: requestContext.cookies,
}));

vi.mock('next/navigation', () => ({
  notFound: requestContext.notFound,
}));

const PREV_DATA_DIR = process.env.INKMARSHAL_DATA_DIR;
const PREV_RUNTIME = process.env.INKMARSHAL_RUNTIME;
const PREV_SESSION = process.env.INKMARSHAL_DESKTOP_SESSION;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'inkmarshal-local-auth-'));
  process.env.INKMARSHAL_DATA_DIR = tmpDir;
});

beforeEach(() => {
  delete process.env.INKMARSHAL_RUNTIME;
  delete process.env.INKMARSHAL_DESKTOP_SESSION;
  requestContext.headers.mockReset().mockResolvedValue(new Headers());
  requestContext.cookies.mockReset().mockResolvedValue({ get: () => undefined });
  requestContext.notFound.mockClear();
});

afterEach(() => {
  if (PREV_RUNTIME === undefined) delete process.env.INKMARSHAL_RUNTIME;
  else process.env.INKMARSHAL_RUNTIME = PREV_RUNTIME;
  if (PREV_SESSION === undefined) delete process.env.INKMARSHAL_DESKTOP_SESSION;
  else process.env.INKMARSHAL_DESKTOP_SESSION = PREV_SESSION;
});

afterAll(async () => {
  const { closeDbForTest } = await import('@/lib/db/connection');
  closeDbForTest();
  if (PREV_DATA_DIR === undefined) delete process.env.INKMARSHAL_DATA_DIR;
  else process.env.INKMARSHAL_DATA_DIR = PREV_DATA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('requireNovelOwner', () => {
  it('rejects novels that exist but belong to a different local user row', async () => {
    const { createNovel, deleteNovelCascade } = await import('@/lib/db');
    const { requireNovelOwner } = await import('@/lib/local-auth');
    const novel = await createNovel({
      userId: 'other-user',
      title: 'Not local-user owned',
    });
    try {
      const result = await requireNovelOwner(novel.id);
      expect(result).toBeInstanceOf(NextResponse);
      expect((result as NextResponse).status).toBe(404);
    } finally {
      await deleteNovelCascade(novel.id, 'other-user');
    }
  });
});

describe('request-local desktop session gate', () => {
  it('rejects a direct Server Action invocation before returning the local user', async () => {
    process.env.INKMARSHAL_RUNTIME = 'desktop';
    process.env.INKMARSHAL_DESKTOP_SESSION = 'a'.repeat(64);
    const { getUser } = await import('@/lib/local-auth');

    await expect(getUser()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(requestContext.notFound).toHaveBeenCalledOnce();
  });

  it('accepts the httpOnly desktop session cookie inside the action', async () => {
    const token = 'a'.repeat(64);
    process.env.INKMARSHAL_RUNTIME = 'desktop';
    process.env.INKMARSHAL_DESKTOP_SESSION = token;
    requestContext.cookies.mockResolvedValue({
      get: (name: string) => name === 'inkmarshal_desktop_session'
        ? { value: token }
        : undefined,
    });
    const { getUser } = await import('@/lib/local-auth');

    await expect(getUser()).resolves.toMatchObject({ id: 'local-user' });
    expect(requestContext.notFound).not.toHaveBeenCalled();
  });
});
