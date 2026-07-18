export const INTERVIEW_FREEFORM_MAX_LENGTH = 4_000;

export function normalizeInterviewFreeformInput(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, INTERVIEW_FREEFORM_MAX_LENGTH);
}
