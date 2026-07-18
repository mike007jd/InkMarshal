import { NextResponse } from 'next/server';

import { consumeLatestBrainstormReceipt } from '@/lib/brainstorm-receipts';
import { requireNovelOwner } from '@/lib/local-auth';

export const runtime = 'nodejs';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  return NextResponse.json(
    { receipt: consumeLatestBrainstormReceipt(id) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
