'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { SearchInputChapter } from '@/lib/search/manuscript-search';
import { GlobalSearchDialog } from './GlobalSearchDialog';

/**
 * Search scope. Two flavours:
 *  - `manuscript`: inside a novel — search chapters; onJump receives
 *    chapterNumber + character offset.
 *  - `novel-list`: studio home — search novel titles; onJump receives novelId.
 */
export interface ManuscriptScope {
  kind: 'manuscript';
  id: string;
  novelId: string;
  chapters: SearchInputChapter[];
  onJump: (chapterNumber: number, offset: number) => void;
}

interface NovelListItem {
  novelId: string;
  title: string;
}

export interface NovelListScope {
  kind: 'novel-list';
  id: string;
  items: NovelListItem[];
  onJump: (novelId: string, chapterNumber?: number, offset?: number) => void;
}

export type SearchScope = ManuscriptScope | NovelListScope;

interface GlobalSearchContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  registerScope: (scope: SearchScope) => () => void;
  activeScope: SearchScope | null;
}

const GlobalSearchContext = createContext<GlobalSearchContextValue | null>(null);

function useGlobalSearch(): GlobalSearchContextValue {
  const ctx = useContext(GlobalSearchContext);
  if (!ctx) {
    throw new Error('useGlobalSearch must be used inside <GlobalSearchProvider>');
  }
  return ctx;
}

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  // Most-recently-registered scope wins. Stored as a LIFO stack so unmounting
  // the manuscript route falls back to the novel-list scope automatically.
  const [scopeStack, setScopeStack] = useState<SearchScope[]>([]);

  const setOpen = useCallback((next: boolean) => setOpenState(next), []);

  const registerScope = useCallback((scope: SearchScope) => {
    setScopeStack(prev => {
      const filtered = prev.filter(s => s.id !== scope.id);
      return [...filtered, scope];
    });
    return () => {
      setScopeStack(prev => prev.filter(s => s.id !== scope.id));
    };
  }, []);

  // Cmd/Ctrl+F is bound by the native menu (W3-4); a JS hotkey for Find would
  // race with the menu and intercept the OS-provided Find shortcut. We listen
  // for the inkmarshal:open-find event the native menu emits AND bind the
  // command-palette-standard Cmd/Ctrl+K directly — Cmd+K does not collide with
  // the OS Find shortcut, so first-time users who reach for the universal
  // palette key (Linear/VSCode/Notion) get the search they can't otherwise see.
  useEffect(() => {
    const onOpenFind = () => setOpenState(true);
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpenState(true);
      }
    };
    window.addEventListener('inkmarshal:open-find', onOpenFind);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('inkmarshal:open-find', onOpenFind);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const activeScope = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
  const novelListScope = [...scopeStack].reverse()
    .find((scope): scope is NovelListScope => scope.kind === 'novel-list') ?? null;

  const value = useMemo<GlobalSearchContextValue>(
    () => ({ open, setOpen, registerScope, activeScope }),
    [open, setOpen, registerScope, activeScope],
  );

  return (
    <GlobalSearchContext.Provider value={value}>
      {children}
      <GlobalSearchDialog
        open={open}
        onOpenChange={setOpen}
        scope={activeScope}
        novelListScope={novelListScope}
      />
    </GlobalSearchContext.Provider>
  );
}

/**
 * Convenience hook: register a scope for the lifetime of the calling
 * component. Pass `null` to skip registration entirely. The scope is
 * re-registered whenever `id`, `kind`, or scope payload changes — keep the
 * `scope` argument memoized at the caller (useMemo with the right deps).
 */
export function useRegisterSearchScope(scope: SearchScope | null): void {
  const { registerScope } = useGlobalSearch();
  useEffect(() => {
    if (!scope) return;
    return registerScope(scope);
  }, [registerScope, scope]);
}
