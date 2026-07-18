import { NextResponse } from 'next/server';

import { undoBrainstormReceipt } from '@/lib/brainstorm-receipts';
import { requireNovelOwner } from '@/lib/local-auth';
import { safeParseJsonObject } from '@/lib/utils';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const parsed = await safeParseJsonObject<{ receiptId?: unknown }>(request, { maxBytes: 4_096 });
  if (parsed.error) return parsed.error as NextResponse;
  const receiptId = typeof parsed.data.receiptId === 'string' ? parsed.data.receiptId.trim() : '';
  if (!receiptId) {
    return NextResponse.json({ error: 'Receipt id is required' }, { status: 400 });
  }

  const result = await undoBrainstormReceipt(id, receiptId);
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : 409;
    return NextResponse.json({ error: result.reason }, { status });
  }
  return NextResponse.json({ ok: true });
}
