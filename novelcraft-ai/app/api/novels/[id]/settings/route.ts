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
import { updateNovel } from '@/lib/db';
import { safeParseJsonObject, sanitizeError } from '@/lib/utils';
import { isCreativityLevel } from '@/lib/ai/generation-presets';
import type { NovelSettings } from '@/lib/db-types';

interface PatchSettingsBody {
  creativity?: unknown;
}

function isSettingsPatchObject(value: unknown): value is PatchSettingsBody {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

  const current: NovelSettings = isSettingsPatchObject(ownerCheck.novel.settings)
    ? ownerCheck.novel.settings
    : {};
  const next: NovelSettings = { ...current };
  let changed = false;

  if (Object.prototype.hasOwnProperty.call(body, 'creativity')) {
    const c = body.creativity;
    if (c === null) {
      changed = Object.prototype.hasOwnProperty.call(current, 'creativity');
      delete next.creativity;
    } else if (isCreativityLevel(c)) {
      changed = current.creativity !== c;
      next.creativity = c;
    } else {
      return NextResponse.json(
        { error: 'creativity must be conservative | balanced | wild' },
        { status: 400 },
      );
    }
  }

  // Collapse empty bag back to NULL so it round-trips clean — keeps the
  // "no opinion → use defaults" semantic explicit at the DB layer too.
  const persisted: NovelSettings | null = Object.keys(next).length === 0 ? null : next;
  if (!changed) {
    return NextResponse.json({ settings: persisted });
  }

  try {
    const updated = await updateNovel(id, { settings: persisted }, true);
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
