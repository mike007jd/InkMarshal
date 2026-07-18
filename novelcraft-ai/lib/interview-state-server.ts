import 'server-only';

import { getNovel, updateNovel } from '@/lib/db';
import { toInterviewState, toJsonb, type InterviewState } from '@/lib/interview-state';

function isInterviewStateShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.mode === 'string' &&
    typeof v.collectedProfile === 'object' &&
    v.collectedProfile !== null
  );
}

export async function getInterviewState(novelId: string): Promise<InterviewState | null> {
  const novel = await getNovel(novelId);
  // Refuse silently corrupt jsonb instead of letting downstream code crash on
  // currentState.collectedProfile being a string or array.
  if (!novel?.interviewState || !isInterviewStateShape(novel.interviewState)) {
    return null;
  }
  return toInterviewState(novel.interviewState);
}

export async function saveInterviewState(novelId: string, state: InterviewState): Promise<InterviewState> {
  const updatedNovel = await updateNovel(novelId, { interviewState: toJsonb(state) });
  if (!updatedNovel) {
    throw new Error('Novel not found');
  }
  return state;
}
