// Local-only user shim for a no-account desktop app.
//
// Every API route calls these instead of any cloud-backed account service.
// They always succeed and return the single fixed local user; there is no
// real authentication in this product.
//
// Exported surface matches what `app/api/**` and `app/actions/**` import:
//   getUser          — used by app/api/novels/route.ts, app/actions/*
//   requireLocalUser — used by API routes that need the fixed local user
//   requireNovelOwner — used by ~25 novel API routes

import { NextResponse } from 'next/server';
import { LOCAL_USER, type LocalUser } from '@/lib/local-user';
import { getActiveNovel, getNovel, isNovelTrashed } from '@/lib/db';
import type { Novel } from '@/lib/db';

export type { LocalUser };

/** Returns the fixed local user. Never rejects. */
export async function getUser(): Promise<LocalUser> {
  return LOCAL_USER;
}

/** Returns `{ user }` for the fixed local user. Never rejects. */
export async function requireLocalUser(): Promise<{ user: LocalUser }> {
  return { user: LOCAL_USER };
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
  const novel = await getActiveNovel(novelId);
  if (!novel || novel.userId !== LOCAL_USER.id) {
    return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
  }
  return { user: LOCAL_USER, novel };
}

/** Ownership gate reserved for Trash restore/permanent-delete endpoints. */
export async function requireTrashedNovelOwner(
  novelId: string,
): Promise<{ user: LocalUser; novel: Novel } | NextResponse> {
  const novel = await getNovel(novelId);
  if (!novel || novel.userId !== LOCAL_USER.id || !isNovelTrashed(novel)) {
    return NextResponse.json({ error: 'Trashed novel not found' }, { status: 404 });
  }
  return { user: LOCAL_USER, novel };
}
