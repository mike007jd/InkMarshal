'use client';

import { useGlobalHotkey } from '@/hooks/useGlobalHotkey';

const HOTKEYS = [
  // File
  ['mod+n', 'inkmarshal.file.new'],
  ['mod+s', 'inkmarshal.file.save'],
  ['mod+e', 'inkmarshal.file.export'],
  ['mod+w', 'inkmarshal.file.closeWindow'],
  // Edit
  ['mod+f', 'inkmarshal.edit.find'],
  // View
  ['mod+1', 'inkmarshal.view.chat'],
  ['mod+2', 'inkmarshal.view.knowledge'],
  ['mod+3', 'inkmarshal.view.conv'],
  ['mod+4', 'inkmarshal.view.manuscript'],
  ['mod+b', 'inkmarshal.view.toggleLeft'],
  ['mod+\\', 'inkmarshal.view.toggleRight'],
  // Models / prefs
  ['mod+m', 'inkmarshal.models'],
  ['mod+,', 'inkmarshal.prefs'],
] as const satisfies ReadonlyArray<readonly [combo: string, id: string]>;

interface UseGlobalHotkeysOptions {
  enabled?: boolean;
}

export function useGlobalHotkeys(
  handleMenuAction: (id: string) => void,
  opts: UseGlobalHotkeysOptions = {},
): void {
  const { enabled = true } = opts;
  for (const [combo, id] of HOTKEYS) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- HOTKEYS is module-constant; order is stable across renders.
    useGlobalHotkey(combo, () => handleMenuAction(id), {
      // Cmd+S/N/E/etc. should always fire — even when the user is typing
      // in a chat box or lexical editor. The handler will dispatch the
      // right inkmarshal event from there.
      ignoreInputs: false,
      enabled,
    });
  }
}
