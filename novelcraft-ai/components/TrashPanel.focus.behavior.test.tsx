// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/LanguageProvider', () => ({
  useLanguage: () => ({
    locale: 'en',
    t: {
      trashTitle: 'Trash',
      trashDescription: 'Restore books to your library or permanently delete them.',
      trashEmpty: 'Trash is empty.',
      trashLoadFailed: 'Failed to load trash',
      trashRestoreAction: 'Restore',
      trashDeletePermanently: 'Delete permanently',
      trashMovedAt: 'Moved {date}',
      trashRestoreSuccess: 'Restored {title}',
      trashRestoreFailed: 'Restore failed',
      trashDeleteSuccess: 'Deleted {title}',
      trashDeleteFailed: 'Delete failed',
      trashDeleteConfirmTitle: 'Delete permanently?',
      trashDeleteConfirmDescription: 'Type {title} to confirm.',
      trashDeleteTypeTitle: 'Title',
      loading: 'Loading',
      cancel: 'Cancel',
      dismiss: 'Dismiss',
    },
  }),
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { TrashPanel } from '@/components/TrashPanel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function installPointerPolyfills() {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => undefined;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => undefined;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      constructor(type: string, params: MouseEventInit = {}) {
        super(type, params);
      }
    }
    Object.defineProperty(window, 'PointerEvent', {
      configurable: true,
      value: PointerEventPolyfill,
    });
  }
}

function installLayoutGeometryPolyfills() {
  // jsdom leaves client rects empty; usable-focus checks need a non-zero box.
  const box = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 24,
    right: 120,
    width: 120,
    height: 24,
    toJSON() {
      return this;
    },
  } satisfies DOMRect;
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => {
    const list = {
      length: 1,
      item: () => box,
      [Symbol.iterator]: function* () {
        yield box;
      },
      0: box,
    } as DOMRectList;
    return list;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(box);
}

function TrashFocusHarness({ hideTrigger = false }: { hideTrigger?: boolean }) {
  const [open, setOpen] = useState(false);
  const moreToolsTriggerRef = useRef<HTMLButtonElement>(null);
  const fallbackFocusRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <div style={hideTrigger ? { display: 'none' } : undefined}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button ref={moreToolsTriggerRef} type="button">
              More tools
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => setOpen(true)}>
              Trash
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <button ref={fallbackFocusRef} type="button">
        Toggle sidebar
      </button>
      <TrashPanel
        open={open}
        onOpenChange={setOpen}
        onLibraryChange={() => undefined}
        returnFocusRef={moreToolsTriggerRef}
        fallbackFocusRef={fallbackFocusRef}
      />
    </>
  );
}

async function openTrashFromMenu() {
  const trigger = screen.getByRole('button', { name: 'More tools' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
  const trash = await screen.findByRole('menuitem', { name: 'Trash' });
  trash.focus();
  fireEvent.keyDown(trash, { key: 'Enter', code: 'Enter' });
  return {
    trigger,
    dismiss: await screen.findByRole('button', { name: 'Dismiss' }),
  };
}

describe('TrashPanel keyboard focus restoration', () => {
  beforeEach(() => {
    installPointerPolyfills();
    installLayoutGeometryPolyfills();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('restores focus to the stable More tools trigger after Escape closes the sheet', async () => {
    render(<TrashFocusHarness />);

    const { trigger, dismiss } = await openTrashFromMenu();
    await waitFor(() => {
      expect(document.activeElement).toBe(dismiss);
    });

    fireEvent.keyDown(dismiss, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('uses the visible fallback when the More tools trigger leaves the layout', async () => {
    const view = render(<TrashFocusHarness />);
    const { dismiss } = await openTrashFromMenu();
    await waitFor(() => {
      expect(document.activeElement).toBe(dismiss);
    });

    view.rerender(<TrashFocusHarness hideTrigger />);
    fireEvent.keyDown(dismiss, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Toggle sidebar' }),
      );
    });
  });
});
