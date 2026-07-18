import { NextResponse } from 'next/server';
import { acquireWritingLock, applyNovelUpdate, getNovel, isInStages, releaseWritingLock } from '@/lib/db';
import { getDb } from '@/lib/db/connection';
import { type Locale, normalizeLocale } from '@/lib/i18n';
import { buildInitialInterviewState, buildNextInterviewState, buildNovelDraftFromInterviewProfile } from '@/lib/interview';
import { normalizeInterviewFreeformInput } from '@/lib/interview-limits';
import { getInterviewState, saveInterviewState } from '@/lib/interview-state-server';
import { toJsonb } from '@/lib/interview-state';
import { requireNovelOwner } from '@/lib/local-auth';
import { safeParseJsonObject } from '@/lib/utils';
import type { NovelStage } from '@/lib/novel-stages';

const STAGES_THAT_CAN_EDIT_INTERVIEW: readonly NovelStage[] = [
  'discovery_interview',
  'ready_for_greenlight',
];
const LOCK_TTL_SEC = 60;

function parseLang(url: string): Locale {
  return normalizeLocale(new URL(url).searchParams.get('lang'));
}

function interviewStageConflict() {
  return NextResponse.json(
    { error: 'Interview can only be changed before writing starts.' },
    { status: 409 },
  );
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  if (!isInStages(ownerCheck.novel.stage, STAGES_THAT_CAN_EDIT_INTERVIEW)) {
    return interviewStageConflict();
  }

  const lock = await acquireWritingLock(id, LOCK_TTL_SEC);
  if (!lock) {
    return NextResponse.json(
      { error: 'Another writing session is already in progress for this novel.' },
      { status: 409 },
    );
  }

  try {
    const lockedNovel = await getNovel(id);
    if (!lockedNovel || !isInStages(lockedNovel.stage, STAGES_THAT_CAN_EDIT_INTERVIEW)) {
      return interviewStageConflict();
    }

    const freshState = buildInitialInterviewState(parseLang(request.url));
    // Reset interview state + stage/progress atomically (see POST for rationale).
    const db = getDb();
    db.transaction(() => {
      applyNovelUpdate(db, id, { interviewState: toJsonb(freshState) });
      applyNovelUpdate(db, id, { stage: 'discovery_interview', progress: 0 });
    })();
    return NextResponse.json(freshState);
  } finally {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  const lang = parseLang(request.url);
  const existing = await getInterviewState(id);
  if (existing) return NextResponse.json(existing);
  if (!isInStages(ownerCheck.novel.stage, STAGES_THAT_CAN_EDIT_INTERVIEW)) {
    return interviewStageConflict();
  }

  const freshNovel = await getNovel(id);
  if (!freshNovel || !isInStages(freshNovel.stage, STAGES_THAT_CAN_EDIT_INTERVIEW)) {
    return interviewStageConflict();
  }

  const fresh = buildInitialInterviewState(lang);
  await saveInterviewState(id, fresh);
  return NextResponse.json(fresh);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;
  if (!isInStages(ownerCheck.novel.stage, STAGES_THAT_CAN_EDIT_INTERVIEW)) {
    return interviewStageConflict();
  }

  const lock = await acquireWritingLock(id, LOCK_TTL_SEC);
  if (!lock) {
    return NextResponse.json(
      { error: 'Another writing session is already in progress for this novel.' },
      { status: 409 },
    );
  }

  try {
    const lockedNovel = await getNovel(id);
    if (!lockedNovel || !isInStages(lockedNovel.stage, STAGES_THAT_CAN_EDIT_INTERVIEW)) {
      return interviewStageConflict();
    }

    const parsed = await safeParseJsonObject<{
      language?: unknown;
      selectedOptionId?: unknown;
      freeform?: unknown;
    }>(request);
    if (parsed.error) return parsed.error as NextResponse;
    const payload = parsed.data;

    const lang = normalizeLocale(typeof payload.language === 'string' ? payload.language : null);
    const currentState = await getInterviewState(id);
    const nextState = currentState
      ? buildNextInterviewState({
          currentState,
          selectedOptionId: typeof payload.selectedOptionId === 'string' ? payload.selectedOptionId : null,
          freeform: normalizeInterviewFreeformInput(payload.freeform),
          language: lang,
        })
      : buildInitialInterviewState(lang);

    // Persist the interview state AND the novel stage-advance in ONE
    // synchronous transaction. The writing lock serializes requests but does
    // not make the two writes atomic — a crash between them used to leave
    // interviewState advanced to proposal_review while the novel stage stayed
    // discovery_interview (desynchronized state).
    const db = getDb();
    db.transaction(() => {
      applyNovelUpdate(db, id, { interviewState: toJsonb(nextState) });
      if (nextState.mode === 'proposal_review') {
        applyNovelUpdate(db, id, {
          ...buildNovelDraftFromInterviewProfile(nextState.collectedProfile, lang),
          stage: 'ready_for_greenlight',
          progress: 0,
        });
      }
    })();

    return NextResponse.json(nextState);
  } finally {
    await releaseWritingLock(id, lock.token).catch(() => undefined);
  }
}
