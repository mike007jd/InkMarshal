'use client';

const LOCAL_MODEL_STATE_CHANGED_EVENT = 'inkmarshal:local-model-state-changed';

export function notifyLocalModelStateChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(LOCAL_MODEL_STATE_CHANGED_EVENT));
}

export function subscribeLocalModelStateChanged(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(LOCAL_MODEL_STATE_CHANGED_EVENT, callback);
  return () => window.removeEventListener(LOCAL_MODEL_STATE_CHANGED_EVENT, callback);
}
