'use client';

import { useEffect, useRef } from 'react';
import { isMacPlatform } from '@/lib/desktop-runtime';

/**
 * Combo string format:
 *   "mod+f"   → Cmd on macOS, Ctrl elsewhere
 *   "mod+shift+z"
 *   "g"       → bare key (no modifier required)
 *
 * Keys are matched case-insensitively against `event.key` (single-char keys are
 * lowercased before comparison so "F" and "f" both match).
 */
export interface UseGlobalHotkeyOptions {
  /** When true (default), skip if the focus is inside an input/textarea/select
   *  or any contenteditable element. Set to false to also fire while typing. */
  ignoreInputs?: boolean;
  /** When true (default), preventDefault on match. Pass false to keep browser
   *  behavior (e.g. when you only want to observe). */
  preventDefault?: boolean;
  /** When false, the hotkey is disabled (use to gate by component state). */
  enabled?: boolean;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // contenteditable host or descendant — lexical's ContentEditable lives here.
  if (target.isContentEditable) return true;
  // walk up just in case the event hit a span inside a contenteditable
  let el: HTMLElement | null = target;
  while (el) {
    if (el.isContentEditable) return true;
    el = el.parentElement;
  }
  return false;
}

interface ParsedCombo {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split('+').map(p => p.trim()).filter(Boolean);
  let mod = false, shift = false, alt = false;
  let key = '';
  for (const part of parts) {
    if (part === 'mod' || part === 'cmd' || part === 'ctrl' || part === 'meta') mod = true;
    else if (part === 'shift') shift = true;
    else if (part === 'alt' || part === 'option') alt = true;
    else key = part;
  }
  return { mod, shift, alt, key };
}

function matches(e: KeyboardEvent, parsed: ParsedCombo): boolean {
  const isMac = isMacPlatform();
  const modPressed = isMac ? e.metaKey : e.ctrlKey;
  if (parsed.mod !== modPressed) return false;
  if (parsed.shift !== e.shiftKey) return false;
  if (parsed.alt !== e.altKey) return false;
  const eventKey = e.key.toLowerCase();
  return eventKey === parsed.key;
}

/**
 * Bind a global hotkey to `handler`. Handler ref is updated every render so
 * closures over local state work without re-binding the listener.
 */
export function useGlobalHotkey(
  combo: string,
  handler: (e: KeyboardEvent) => void,
  opts: UseGlobalHotkeyOptions = {},
): void {
  const handlerRef = useRef(handler);
  // Keep the ref pointed at the latest handler — done in an effect rather than
  // during render to satisfy react-hooks/refs.
  useEffect(() => {
    handlerRef.current = handler;
  });

  const { ignoreInputs = true, preventDefault = true, enabled = true } = opts;

  useEffect(() => {
    if (!enabled) return;
    const parsed = parseCombo(combo);
    if (!parsed.key) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!matches(e, parsed)) return;
      if (ignoreInputs && isEditableTarget(e.target)) return;
      if (preventDefault) e.preventDefault();
      handlerRef.current(e);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [combo, enabled, ignoreInputs, preventDefault]);
}
