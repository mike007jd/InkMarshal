import { NextResponse } from 'next/server';
import {
  acquireWritingLock,
  getNovel,
  isInStages,
  releaseWritingLock,
  STAGES_THAT_SHOW_UNIFICATION_PANEL,
} from '@/lib/db';
import { requireNovelOwner } from '@/lib/local-auth';
import { safeParseJsonObject, sanitizeError } from '@/lib/utils';
import { formatStartWritingLog, isStartWritingDebugEnabled, START_WRITING_EVENTS } from '@/lib/start-writing-logging';
import { applyAndPersistUnificationEdits } from '@/lib/whole-book-unification';

export const MAX_UNIFICATION_SELECTION_IDS = 1_000;
const MAX_UNIFICATION_SELECTION_ID_LENGTH = 128;
const LOCK_TTL_SEC = 300;

export function normalizeUnificationSelectionIds(
  value: unknown,
  validIds: readonly string[],
  fieldName: string,
): { ids: string[] } | { error: string } {
  if (!Array.isArray(value)) return { ids: [] };
  if (value.length > MAX_UNIFICATION_SELECTION_IDS) {
    return { error: `${fieldName} contains too many ids` };
  }

  const valid = new Set(validIds);
  const normalized = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (item.length > MAX_UNIFICATION_SELECTION_ID_LENGTH) {
      return { error: `${fieldName} contains an invalid id` };
    }
    if (valid.has(item)) normalized.add(item);
  }
  return { ids: Array.from(normalized) };
}

// Applies a subset of unification edits. Each edit is a verbatim find/replace
// against a chapter's current content. We use the chapter's optimistic-lock
// `version` field to safely retry if the user edited the chapter mid-flight.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const parsed = await safeParseJsonObject<{
    editIds?: unknown;
    applyAll?: unknown;
    skipIds?: unknown;
    skipAll?: unknown;
  }>(req);
  if (parsed.error) return parsed.error as NextResponse;
  const applyAll = parsed.data.applyAll === true;
  const skipAll = parsed.data.skipAll === true;
  // applyAll and skipAll are mutually exclusive — accepting both (or a
  // self-contradictory applyAll+skipIds / skipAll+editIds) used to silently let
  // skipAll win downstream, masking a malformed request. Reject it up front.
  if (applyAll && skipAll) {
    return NextResponse.json(
      { error: 'Conflicting selection flags: applyAll and skipAll are mutually exclusive.' },
      { status: 400 },
    );
  }

  const lock = await acquireWritingLock(id, LOCK_TTL_SEC);
  if (!lock) {
    return NextResponse.json(
      { error: 'Another writing session is already in progress for this novel.' },
      { status: 409 },
    );
  }

  try {
    const currentNovel = await getNovel(id);
    if (!currentNovel || currentNovel.userId !== ownerCheck.user.id) {
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }
    if (!isInStages(currentNovel.stage, STAGES_THAT_SHOW_UNIFICATION_PANEL)) {
      return NextResponse.json(
        { error: 'Unification edits can only be applied during polishing or after completion.' },
        { status: 409 },
      );
    }

    const report = currentNovel.unificationReport;
    if (!report) {
      return NextResponse.json({ error: 'No unification report to apply.' }, { status: 409 });
    }
    const validIds = report.edits.map(edit => edit.id);
    const editIdsResult = normalizeUnificationSelectionIds(parsed.data.editIds, validIds, 'editIds');
    if ('error' in editIdsResult) {
      return NextResponse.json({ error: editIdsResult.error }, { status: 400 });
    }
    const skipIdsResult = normalizeUnificationSelectionIds(parsed.data.skipIds, validIds, 'skipIds');
    if ('error' in skipIdsResult) {
      return NextResponse.json({ error: skipIdsResult.error }, { status: 400 });
    }
    const editIds = editIdsResult.ids;
    const skipIds = skipIdsResult.ids;
    // Flag/id contradictions: applyAll with explicit skips, or skipAll with
    // explicit applies, are ambiguous — reject rather than silently applying
    // the downstream precedence.
    if (applyAll && skipIds.length > 0) {
      return NextResponse.json(
        { error: 'Conflicting selection flags: applyAll cannot be combined with skipIds.' },
        { status: 400 },
      );
    }
    if (skipAll && editIds.length > 0) {
      return NextResponse.json(
        { error: 'Conflicting selection flags: skipAll cannot be combined with editIds.' },
        { status: 400 },
      );
    }

    const applyResult = applyAndPersistUnificationEdits({
      novelId: id,
      report,
      applyAll,
      editIds,
      skipAll,
      skipIds,
    });
    if (applyResult.results.length === 0 && !applyResult.allDone) {
      return NextResponse.json({ error: 'No unapplied edits matched the request.' }, { status: 409 });
    }

    if (isStartWritingDebugEnabled()) {
      console.info(formatStartWritingLog(START_WRITING_EVENTS.unifyApply, {
        id,
        applied: applyResult.results.filter(r => r.status === 'applied').length,
        conflict: applyResult.results.filter(r => r.status === 'conflict').length,
        notFound: applyResult.results.filter(r => r.status === 'not_found').length,
      }));
    }

    return NextResponse.json({ results: applyResult.results, allDone: applyResult.allDone });
  } catch (err) {
    console.error('Unify apply error:', err);
    return NextResponse.json({ error: sanitizeError(err, 'Failed to apply edits') }, { status: 500 });
  } finally {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
  }
}
