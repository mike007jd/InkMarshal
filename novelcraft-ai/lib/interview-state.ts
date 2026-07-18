export type InterviewStageName = 'icebreaker' | 'framework' | 'world_and_characters' | 'plot_and_tone' | 'ai_dynamic' | 'proposal_review';

interface InterviewOption {
  id: string;
  label: string;
  description: string;
}

/**
 * Versioning convention: `_v` tags every persisted InterviewState so a future
 * shape change can branch on it during reads. `undefined`/absent is accepted
 * for test/imported rows and is normalized to `_v=1`.
 */
const INTERVIEW_STATE_VERSION = 1;

export interface InterviewState {
  /** Persistence version. Always 1 in the current code. */
  _v?: number;
  mode: 'interview' | 'proposal_review';
  currentQuestionId: string | null;
  currentQuestion: string | null;
  currentHelperText: string | null;
  currentOptions: InterviewOption[];
  recommendedOptionId: string | null;
  slotTarget: string | null;
  missingFields: string[];
  collectedProfile: Record<string, string>;
  proposalSummary: string | null;
  proposalVersion: number;
  interviewStage: InterviewStageName;
  stageProgress: { current: number; total: number };
}

/**
 * Convert a jsonb Record to a typed InterviewState. Adds the current `_v`
 * tag when missing so subsequent writes carry the version, and refuses
 * to load future versions the runtime can't safely interpret.
 */
export function toInterviewState(raw: Record<string, unknown>): InterviewState {
  const storedV = typeof raw._v === 'number' ? raw._v : 0;
  if (storedV > INTERVIEW_STATE_VERSION) {
    throw new Error(
      `InterviewState version ${storedV} exceeds the highest supported version ${INTERVIEW_STATE_VERSION}. This novel was written by a newer build of InkMarshal.`,
    );
  }
  const upgraded = storedV === INTERVIEW_STATE_VERSION ? raw : { ...raw, _v: INTERVIEW_STATE_VERSION };
  return upgraded as unknown as InterviewState;
}

/** Convert typed InterviewState to jsonb-compatible Record (single cast point) */
export function toJsonb(state: InterviewState): Record<string, unknown> {
  return { ...state, _v: state._v ?? INTERVIEW_STATE_VERSION } as unknown as Record<string, unknown>;
}
