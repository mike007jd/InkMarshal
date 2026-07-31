import { NextResponse } from 'next/server';

import { resetLocalLibrary } from '@/lib/db/local-library-reset';
import { requireLocalUser } from '@/lib/local-auth';

export async function POST() {
  await requireLocalUser();

  try {
    resetLocalLibrary();
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('resetLocalLibrary failed:', error);
    return NextResponse.json(
      { error: 'Failed to reset local library' },
      { status: 500 },
    );
  }
}
