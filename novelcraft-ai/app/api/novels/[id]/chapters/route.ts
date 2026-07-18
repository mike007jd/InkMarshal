import { NextResponse } from 'next/server';
import { getChapters, getChaptersLite } from '@/lib/db';
import { requireNovelOwner } from '@/lib/local-auth';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const { searchParams } = new URL(request.url);
  const chapters = searchParams.get('lite') === '1'
    ? await getChaptersLite(id)
    : await getChapters(id);
  return NextResponse.json(chapters);
}
