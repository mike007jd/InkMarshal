import { NextResponse } from 'next/server';

import { clearLocalLibraryContent } from '@/lib/db/local-library-reset';
import { requireLocalUser } from '@/lib/local-auth';

export async function POST() {
  await requireLocalUser();

  try {
    clearLocalLibraryContent();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('clearLocalLibraryContent failed:', error);
    return NextResponse.json(
      { error: 'Failed to clear local library content' },
      { status: 500 },
    );
  }
}
