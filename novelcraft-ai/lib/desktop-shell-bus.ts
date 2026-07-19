'use client';

const SHELL_TOGGLE_LEFT = 'inkmarshal:shell:toggle-left';
const SHELL_TOGGLE_RIGHT = 'inkmarshal:shell:toggle-right';
export const MANUSCRIPT_FLUSH_EVENT = 'inkmarshal:manuscript-flush';

export interface ManuscriptFlushOutcome {
  ok: boolean;
  chapterNumber?: number;
  title?: string;
}

export interface ManuscriptFlushEventDetail {
  createSnapshot?: boolean;
  waitUntil(promise: Promise<ManuscriptFlushOutcome>): void;
}

export interface RequestManuscriptFlushOptions {
  createSnapshot?: boolean;
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
 * returns a {@link ManuscriptFlushOutcome}; on failure the surface that failed first
 * gets attributed so callers can name the affected chapter in their error.
 */
export async function requestManuscriptFlush(
  options: RequestManuscriptFlushOptions = {},
): Promise<ManuscriptFlushOutcome> {
  if (typeof window === 'undefined') return { ok: true };
  const waits: Promise<ManuscriptFlushOutcome>[] = [];
  const detail: ManuscriptFlushEventDetail = {
    createSnapshot: options.createSnapshot,
    waitUntil(promise) {
      waits.push(
        Promise.resolve(promise).catch(() => ({ ok: false } satisfies ManuscriptFlushOutcome)),
      );
    },
  };
  window.dispatchEvent(new CustomEvent<ManuscriptFlushEventDetail>(MANUSCRIPT_FLUSH_EVENT, { detail }));
  if (waits.length === 0) return { ok: true };
  const results = await Promise.all(waits);
  return results.find(r => !r.ok) ?? { ok: true };
}
