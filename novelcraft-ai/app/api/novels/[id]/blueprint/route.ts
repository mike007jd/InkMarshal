import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { projectBlueprintFromOutline } from '@/lib/ai/blueprint-projection';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  const { novel } = ownerCheck;

  // W2-D: blueprint is no longer a stored column. We project it on demand
  // from the outline knowledge entries (FS-backed mirror, falls through to
  // the canonical table when the index is empty).
  const blueprint = await projectBlueprintFromOutline(id);
  return NextResponse.json({
    blueprint,
    targetWords: novel.targetWords,
  });
}
