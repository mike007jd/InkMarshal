import { NextResponse } from 'next/server';

import { getTrashedNovels } from '@/lib/db';
import { requireLocalUser } from '@/lib/local-auth';

export const runtime = 'nodejs';

export async function GET() {
  const { user } = await requireLocalUser();
  return NextResponse.json(await getTrashedNovels(user.id));
}
