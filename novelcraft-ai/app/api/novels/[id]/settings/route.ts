// PATCH /api/novels/[id]/settings — merges into novel.settings JSON bag.
//
// Kept separate from PATCH /api/novels/[id] because that route only accepts
// the user-writable surface (title/genre/targetWords). Settings is its own
// concept (UI/AI knobs, not "novel metadata") so a dedicated endpoint avoids
// growing the safe-fields whitelist for what is a different access pattern
// (debounced auto-save from the writing surface, not the rename dialog).
//
// Contract:
//   PATCH body: { creativity?: 'conservative' | 'balanced' | 'wild' | null }
//     - undefined → field untouched.
//     - null      → field cleared (revert to OPERATION_DEFAULT_CREATIVITY).
//     - string    → must pass isCreativityLevel.
//   Response:    the freshly-updated Novel.settings bag.
//
// Future fields (defaultStyleId, variantCount, …) plug in the same way.

import { NextResponse } from 'next/server';
import { requireNovelOwner } from '@/lib/local-auth';
import { patchNovelSettings } from '@/lib/db';
import { safeParseJsonObject, sanitizeError } from '@/lib/utils';
import { isCreativityLevel } from '@/lib/ai/generation-presets';
import type { NovelSettings } from '@/lib/db-types';

interface PatchSettingsBody {
  creativity?: unknown;
}

function hasOnlySupportedSettingsKeys(value: PatchSettingsBody): boolean {
  return Object.keys(value).every(key => key === 'creativity');
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const parsed = await safeParseJsonObject<PatchSettingsBody>(
    request,
    { errorMessage: 'settings body must be an object' },
  );
  if (parsed.error) return parsed.error;

  // safeParseJsonObject already guarantees a non-null, non-array object here
  // (same 'settings body must be an object' / 400 contract), so no re-check.
  const body = parsed.data;
  if (!hasOnlySupportedSettingsKeys(body)) {
    return NextResponse.json({ error: 'unsupported settings field' }, { status: 400 });
  }

  const patch: Partial<Omit<NovelSettings, 'importMeta'>> = {};
  const clearKeys: Array<keyof Omit<NovelSettings, 'importMeta'>> = [];
  if (Object.prototype.hasOwnProperty.call(body, 'creativity')) {
    const c = body.creativity;
    if (c === null) {
      clearKeys.push('creativity');
    } else if (isCreativityLevel(c)) {
      patch.creativity = c;
    } else {
      return NextResponse.json(
        { error: 'creativity must be conservative | balanced | wild' },
        { status: 400 },
      );
    }
  }

  try {
    const updated = await patchNovelSettings(id, patch, clearKeys);
    if (!updated) {
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }
    return NextResponse.json({ settings: updated.settings ?? null });
  } catch (error) {
    console.error('updateNovel settings failed:', error);
    return NextResponse.json(
      { error: sanitizeError(error, 'Failed to update settings') },
      { status: 500 },
    );
  }
}
