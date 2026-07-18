import { NextResponse } from 'next/server';

import { deleteTrashedNovelPermanently } from '@/lib/db';
import { requireTrashedNovelOwner } from '@/lib/local-auth';

export const runtime = 'nodejs';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireTrashedNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const deleted = await deleteTrashedNovelPermanently(id, ownerCheck.user.id);
  if (!deleted) return NextResponse.json({ error: 'Permanent delete failed' }, { status: 409 });
  return NextResponse.json({ ok: true });
}
