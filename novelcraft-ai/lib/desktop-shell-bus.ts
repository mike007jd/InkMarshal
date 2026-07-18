'use client';

const SHELL_TOGGLE_LEFT = 'inkmarshal:shell:toggle-left';
const SHELL_TOGGLE_RIGHT = 'inkmarshal:shell:toggle-right';
export const SAVE_NOW_EVENT = 'inkmarshal:save-now';

export interface SaveNowOutcome {
  ok: boolean;
  chapterNumber?: number;
  title?: string;
}

export interface SaveNowEventDetail {
  createRecoveryPoint?: boolean;
  waitUntil(promise: Promise<SaveNowOutcome>): void;
}

export interface RequestSaveNowOptions {
  createRecoveryPoint?: boolean;
}

function safeDispatch(event: string, detail?: unknown) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

export function toggleLeftSidebar() {
  safeDispatch(SHELL_TOGGLE_LEFT);
}

export function toggleRightPanel() {
  safeDispatch(SHELL_TOGGLE_RIGHT);
}

export function setNovelView(view: 'agent' | 'story-deck' | 'read-edit' | 'chat' | 'knowledge' | 'conversations' | 'manuscript') {
  safeDispatch('inkmarshal://menu', { view });
}

/**
 * Ask the active editing surface to flush unsaved draft text before another
 * action snapshots, exports, searches, or mutates the same chapter. Always
 * returns a {@link SaveNowOutcome}; on failure the surface that failed first
 * gets attributed so callers can name the affected chapter in their error.
 */
export async function requestSaveNow(options: RequestSaveNowOptions = {}): Promise<SaveNowOutcome> {
  if (typeof window === 'undefined') return { ok: true };
  const waits: Promise<SaveNowOutcome>[] = [];
  const detail: SaveNowEventDetail = {
    createRecoveryPoint: options.createRecoveryPoint,
    waitUntil(promise) {
      waits.push(
        Promise.resolve(promise).catch(() => ({ ok: false } satisfies SaveNowOutcome)),
      );
    },
  };
  window.dispatchEvent(new CustomEvent<SaveNowEventDetail>(SAVE_NOW_EVENT, { detail }));
  if (waits.length === 0) return { ok: true };
  const results = await Promise.all(waits);
  return results.find(r => !r.ok) ?? { ok: true };
}
