export type StartWritingLogFields = Record<
  string,
  string | number | boolean | undefined
>;

export type StartWritingEndReason =
  | 'complete'
  | 'batch_complete'
  | 'error'
  | 'aborted'
  | 'controller_closed'
  | 'lock_failed'
  | 'unknown';

// Standard event names emitted by start-writing and the long-novel helpers.
// Listed here so consumers (logs, future telemetry) can rely on a known set.
export const START_WRITING_EVENTS = {
  begin: 'begin',
  lockAcquired: 'lock_acquired',
  lockRenewed: 'lock_renewed',
  lockReleased: 'lock_released',
  lockFailed: 'lock_failed',
  blueprintStart: 'blueprint_start',
  blueprintReused: 'blueprint_reused',
  blueprintDone: 'blueprint_done',
  blueprintPersisted: 'blueprint_persisted',
  chapterStart: 'chapter_start',
  chapterDone: 'chapter_done',
  lengthRetry: 'length_retry',
  summarizeDone: 'summarize_done',
  validateDone: 'validate_done',
  unifyStart: 'unify_start',
  unifyDone: 'unify_done',
  unifyApply: 'unify_apply',
  complete: 'complete',
  error: 'error',
  aborted: 'aborted',
  streamClosed: 'stream_closed',
  end: 'end',
} as const;

export function formatStartWritingLog(
  event: string,
  fields: StartWritingLogFields = {}
): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);

  return parts.length > 0
    ? `[start-writing] ▶ ${event} | ${parts.join(' | ')}`
    : `[start-writing] ▶ ${event}`;
}

export function isStartWritingDebugEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.START_WRITING_DEBUG === '1' || env.NODE_ENV !== 'production';
}

const PRODUCTION_START_WRITING_EVENTS = new Set<string>([
  START_WRITING_EVENTS.begin,
  START_WRITING_EVENTS.blueprintStart,
  START_WRITING_EVENTS.blueprintDone,
  START_WRITING_EVENTS.blueprintPersisted,
  START_WRITING_EVENTS.chapterStart,
  START_WRITING_EVENTS.chapterDone,
  START_WRITING_EVENTS.complete,
  START_WRITING_EVENTS.error,
  START_WRITING_EVENTS.aborted,
  START_WRITING_EVENTS.end,
]);

/**
 * The `log(event, fields)` closure shared by the start-writing and unify
 * routes: evaluates the debug gate once, prefixes every line with the novel
 * `id`, and no-ops when start-writing debug logging is disabled.
 */
export function createStartWritingLogger(
  id: string,
): (event: string, fields?: StartWritingLogFields) => void {
  const debugEnabled = isStartWritingDebugEnabled();
  return (event, fields = {}) => {
    if (!debugEnabled && !PRODUCTION_START_WRITING_EVENTS.has(event)) return;
    console.info(formatStartWritingLog(event, { id, ...fields }));
  };
}

export function shouldFinalizeStartWriting(reason: StartWritingEndReason): boolean {
  return reason !== 'aborted'
    && reason !== 'controller_closed'
    && reason !== 'batch_complete'
    && reason !== 'lock_failed';
}
