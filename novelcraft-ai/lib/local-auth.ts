// Local-only user shim for a no-account desktop app.
//
// Every API route calls these instead of any cloud-backed account service.
// They return the single fixed local user after re-checking the desktop session
// inside the request handler. Proxy remains the outer boundary, but Server
// Actions are public endpoints and must not depend on route matching alone.
//
// Exported surface matches what `app/api/**` and `app/actions/**` import:
//   getUser          — used by app/api/novels/route.ts, app/actions/*
//   requireLocalUser — used by API routes that need the fixed local user
//   requireNovelOwner — used by ~25 novel API routes

import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { LOCAL_USER, type LocalUser } from '@/lib/local-user';
import { getActiveNovel, getNovel, isNovelTrashed } from '@/lib/db';
import type { Novel } from '@/lib/db';
import {
  DESKTOP_SESSION_COOKIE,
  hasValidDesktopSessionCredential,
} from '@/lib/desktop-session-auth';

export type { LocalUser };

async function requireDesktopSession(): Promise<void> {
  if (process.env.INKMARSHAL_RUNTIME !== 'desktop') return;
  const [requestHeaders, requestCookies] = await Promise.all([headers(), cookies()]);
  if (hasValidDesktopSessionCredential({
    header: requestHeaders.get('x-inkmarshal-desktop-session') ?? undefined,
    cookie: requestCookies.get(DESKTOP_SESSION_COOKIE)?.value,
  })) return;
  notFound();
}

/** Returns the fixed local user after the request-local desktop session gate. */
export async function getUser(): Promise<LocalUser> {
  await requireDesktopSession();
  return LOCAL_USER;
}

/** Returns `{ user }` for the fixed local user after the session gate. */
export async function requireLocalUser(): Promise<{ user: LocalUser }> {
  return { user: await getUser() };
}

/**
 * Verifies that the novel `novelId` exists (and belongs to the local user).
 * Returns `{ user, novel }` on success, or a `NextResponse` (404/403) on
 * failure — matching the exact pattern call-sites expect:
 *   `if (ownerCheck instanceof NextResponse) return ownerCheck;`
 */
export async function requireNovelOwner(
  novelId: string,
): Promise<{ user: LocalUser; novel: Novel } | NextResponse> {
  const user = await getUser();
  const novel = await getActiveNovel(novelId);
  if (!novel || novel.userId !== user.id) {
    return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
  }
  return { user, novel };
}

/** Ownership gate reserved for Trash restore/permanent-delete endpoints. */
export async function requireTrashedNovelOwner(
  novelId: string,
): Promise<{ user: LocalUser; novel: Novel } | NextResponse> {
  const user = await getUser();
  const novel = await getNovel(novelId);
  if (!novel || novel.userId !== user.id || !isNovelTrashed(novel)) {
    return NextResponse.json({ error: 'Trashed novel not found' }, { status: 404 });
  }
  return { user, novel };
}
