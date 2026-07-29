// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pathname: '/desktop-studio',
  developerTools: false,
  push: vi.fn(),
  menuHandler: null as null | ((id: string) => void),
  /** When true, `(max-width: 1023px)` matches — the 768–1023 narrow drawer path. */
  matchMediaNarrow: false,
  /** Retained change listeners keyed by media query string. */
  matchMediaListeners: new Map<string, Set<(event: MediaQueryListEvent) => void>>(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock('@/components/LanguageProvider', () => ({
  useLanguage: () => ({
    locale: 'en',
    t: {
      appName: 'InkMarshal',
      newNovel: 'New Novel',
      searchAction: 'Search',
      yourProjects: 'My Desk',
      noNovels: 'Empty desk',
      loading: 'Loading',
      errorLoadProjects: 'Failed to load',
      toastRetry: 'Retry',
      untitledNovel: 'Untitled',
      workspaceTools: 'Tools',
      navModels: 'Models',
      settings: 'Settings',
      moreTools: 'More tools',
      navWorkflows: 'Workflows',
      navSeries: 'Series',
      navUsage: 'Usage & Cost',
      trashTitle: 'Trash',
      toggleSidebar: 'Toggle sidebar',
      moveToTrashAction: 'Move to trash',
      moveToTrashSuccess: 'Moved {title} to trash',
      errorDeleteNovel: 'Delete failed',
      modelReadinessCoverage: '{ready}/{total}',
      modelReadinessCoverageComplete: 'All roles ready',
      modelReadinessCoverageTooltip: '{ready}/{total} ready: {roles}',
      stages: {
        discovery_interview: 'Brainstorm',
        ready_for_greenlight: 'Ready',
        autonomous_writing: 'Writing',
        whole_book_unification: 'Unify',
        completed: 'Done',
      },
    },
  }),
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/lib/use-storage', () => ({
  useNovels: () => ({
    novels: [
      {
        id: 'novel-a',
        title: 'Novel A',
        genre: 'Fantasy',
        stage: 'discovery_interview',
        progress: 0,
        settings: {},
      },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock('@/components/search/GlobalSearchProvider', () => ({
  useRegisterSearchScope: () => undefined,
}));

vi.mock('@/hooks/useGlobalHotkeys', () => ({
  useGlobalHotkeys: () => undefined,
}));

vi.mock('@/hooks/useMenuEvents', () => ({
  useMenuEvents: (handler: (id: string) => void) => {
    mocks.menuHandler = handler;
  },
}));

vi.mock('@/lib/desktop-runtime', () => ({
  isTauriRuntime: () => false,
  openExternal: vi.fn(),
  engineStatus: async () => [],
}));

vi.mock('@/lib/desktop-shell-bus', () => ({
  toggleLeftSidebar: vi.fn(),
  toggleRightPanel: vi.fn(),
  setNovelView: vi.fn(),
  requestManuscriptFlush: vi.fn(),
}));

vi.mock('@/lib/model-supply/connections', () => ({
  getCapabilityProfile: () => ({
    draft: null,
    rewrite: null,
    planning: null,
    recall: null,
  }),
  getConnections: () => [],
  subscribeConnectionsStore: () => () => undefined,
}));

vi.mock('@/lib/model-supply/orchestrator', () => ({
  restoreEnginesOnLaunch: async () => undefined,
}));

vi.mock('@/lib/model-supply/runtime-health', () => ({
  checkConnectionHealth: async () => ({
    reachable: false,
    transportOk: false,
    models: [],
  }),
}));

vi.mock('@/lib/app-settings-client', () => ({
  hydrateAppSettings: async () => ({ ok: true }),
}));

vi.mock('@/lib/model-supply/local-model-events', () => ({
  subscribeLocalModelStateChanged: () => () => undefined,
}));

vi.mock('@/lib/settings', () => ({
  getSettings: () => ({ developerTools: mocks.developerTools }),
}));

vi.mock('@/lib/novel-workspace-preferences', () => ({
  useRememberedNovelViews: () => ({}),
}));

vi.mock('@/components/DeleteNovelDialog', () => ({
  DeleteNovelDialog: () => null,
}));

vi.mock('@/components/TrashPanel', () => ({
  TrashPanel: ({ open }: { open: boolean }) => (
    open ? <div data-testid="trash-panel">Trash panel</div> : null
  ),
}));

vi.mock('@/components/AIActionGateCoordinator', () => ({
  AIActionGateCoordinator: () => null,
}));

vi.mock('@/components/DesktopUpdateCoordinator', () => ({
  DesktopUpdateCoordinator: () => null,
}));

vi.mock('@/components/VaultRuntimeCoordinator', () => ({
  VaultRuntimeCoordinator: () => null,
}));

vi.mock('@/components/ModelsPanel', () => ({
  ModelsPanel: () => null,
}));

vi.mock('@/components/SettingsPanel', () => ({
  SettingsPanel: () => null,
}));

vi.mock('@/components/Icons', () => ({
  InkMarshalLogo: () => <span data-testid="logo" />,
  ManuscriptIcon: () => <span data-testid="manuscript-icon" />,
}));

vi.mock('@/components/BookOrnaments', () => ({
  OrnamentalDivider: () => <hr data-testid="ornament" />,
}));

import { DesktopShell } from '@/components/DesktopShellLayout';

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

function installMatchMedia() {
  mocks.matchMediaListeners.clear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => {
      let listeners = mocks.matchMediaListeners.get(query);
      if (!listeners) {
        listeners = new Set();
        mocks.matchMediaListeners.set(query, listeners);
      }
      const queryListeners = listeners;
      return {
        get matches() {
          return query === '(max-width: 1023px)' ? mocks.matchMediaNarrow : false;
        },
        media: query,
        onchange: null,
        addListener: (listener: (event: MediaQueryListEvent) => void) => {
          queryListeners.add(listener);
        },
        removeListener: (listener: (event: MediaQueryListEvent) => void) => {
          queryListeners.delete(listener);
        },
        addEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) => {
          if (type !== 'change') return;
          queryListeners.add(listener as (event: MediaQueryListEvent) => void);
        },
        removeEventListener: (
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) => {
          if (type !== 'change') return;
          queryListeners.delete(listener as (event: MediaQueryListEvent) => void);
        },
        dispatchEvent: vi.fn(),
      };
    }),
  );
}

function fireMaxWidthBreakpointChange(matches: boolean) {
  mocks.matchMediaNarrow = matches;
  const listeners = mocks.matchMediaListeners.get('(max-width: 1023px)');
  const event = { matches, media: '(max-width: 1023px)' } as MediaQueryListEvent;
  act(() => {
    listeners?.forEach(listener => listener(event));
  });
}

// The narrow drawer starts with Tailwind `invisible` until lg+. jsdom has no
// stylesheet cascade, so Testing Library treats the aside tree as hidden.
const SIDEBAR_QUERY = { hidden: true } as const;

function workspaceAnchorSnapshot(shell: HTMLElement) {
  const aside = shell.querySelector('aside');
  expect(aside).toBeTruthy();
  const root = within(aside as HTMLElement);
  const models = root.getByRole('link', { name: /Models/, ...SIDEBAR_QUERY });
  const settings = root.getByRole('button', { name: /Settings/, ...SIDEBAR_QUERY });
  const moreTools = root.getByRole('button', { name: /More tools/, ...SIDEBAR_QUERY });
  const projectsHeading = root.getByText('My Desk');
  const canvas = within(shell).getByTestId('shell-canvas');
  return {
    models,
    settings,
    moreTools,
    projectsHeading,
    canvas,
    modelsPrevious: models.previousElementSibling,
    settingsPrevious: settings.previousElementSibling,
    moreToolsPrevious: moreTools.previousElementSibling,
    asideChildCount: aside!.childElementCount,
    mainChildCount: shell.querySelector('main')?.childElementCount ?? -1,
  };
}

function moreToolsTrigger() {
  return screen.getByRole('button', { name: /More tools/, ...SIDEBAR_QUERY });
}

function shellAside() {
  const aside = document.querySelector('aside');
  expect(aside).toBeTruthy();
  return aside as HTMLElement;
}

function activeShapeCue(trigger: HTMLElement) {
  return Array.from(trigger.querySelectorAll('span[aria-hidden="true"]')).find(el =>
    el.className.includes('rounded-full'),
  );
}

async function openMoreToolsMenu(trigger: HTMLElement) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
  await waitFor(() => {
    expect(screen.getByRole('menu')).toBeTruthy();
  });
  return screen.getByRole('menu');
}

function invokeToggleLeft() {
  expect(mocks.menuHandler).toBeTypeOf('function');
  act(() => {
    mocks.menuHandler!('inkmarshal.view.toggleLeft');
  });
}

beforeEach(() => {
  mocks.pathname = '/desktop-studio';
  mocks.developerTools = false;
  mocks.push.mockReset();
  mocks.menuHandler = null;
  mocks.matchMediaNarrow = false;
  installPointerPolyfills();
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DesktopShell More tools secondary navigation', () => {
  it('opens a portaled menu without reflowing Models, Settings, projects, or canvas', async () => {
    const { container } = render(
      <DesktopShell>
        <div data-testid="shell-canvas">Canvas</div>
      </DesktopShell>,
    );
    const shell = container.firstElementChild as HTMLElement;
    const before = workspaceAnchorSnapshot(shell);
    expect(before.moreTools.getAttribute('aria-haspopup')).toBeTruthy();
    expect(before.moreTools.getAttribute('aria-expanded')).toBe('false');
    expect(shell.querySelector('[data-slot="collapsible"]')).toBeNull();

    const menu = await openMoreToolsMenu(before.moreTools);
    expect(before.moreTools.getAttribute('aria-expanded')).toBe('true');
    expect(menu.getAttribute('data-side')).toBe('right');
    // Portaled overlay: menu content must leave the sidebar tree so opening it
    // cannot push Models/Settings/projects/canvas.
    expect(shell.querySelector('aside')?.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);

    const after = workspaceAnchorSnapshot(shell);
    expect(after.models).toBe(before.models);
    expect(after.settings).toBe(before.settings);
    expect(after.moreTools).toBe(before.moreTools);
    expect(after.projectsHeading).toBe(before.projectsHeading);
    expect(after.canvas).toBe(before.canvas);
    expect(after.modelsPrevious).toBe(before.modelsPrevious);
    expect(after.settingsPrevious).toBe(before.settingsPrevious);
    expect(after.moreToolsPrevious).toBe(before.moreToolsPrevious);
    expect(after.asideChildCount).toBe(before.asideChildCount);
    expect(after.mainChildCount).toBe(before.mainChildCount);

    expect(within(menu).getByRole('menuitem', { name: /Series/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Usage & Cost/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Trash/ })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: /Workflows/ })).toBeNull();
  });

  it('gates Workflows behind developerTools and keeps Series/Usage/Trash available', async () => {
    mocks.developerTools = true;
    render(
      <DesktopShell>
        <div data-testid="shell-canvas">Canvas</div>
      </DesktopShell>,
    );

    const trigger = moreToolsTrigger();
    const menu = await openMoreToolsMenu(trigger);
    const workflows = within(menu).getByRole('menuitem', { name: /Workflows/ });
    const series = within(menu).getByRole('menuitem', { name: /Series/ });
    const usage = within(menu).getByRole('menuitem', { name: /Usage & Cost/ });
    expect(workflows.getAttribute('href')).toBe('/desktop-studio/workflows');
    expect(series.getAttribute('href')).toBe('/desktop-studio/series');
    expect(usage.getAttribute('href')).toBe('/desktop-studio/usage');

    fireEvent.click(within(menu).getByRole('menuitem', { name: /Trash/ }));
    await waitFor(() => {
      expect(screen.getByTestId('trash-panel')).toBeTruthy();
    });
  });

  it('marks the closed More tools trigger as Series-active with a non-color shape cue', () => {
    mocks.pathname = '/desktop-studio/series';
    render(
      <DesktopShell>
        <div data-testid="shell-canvas">Canvas</div>
      </DesktopShell>,
    );

    // Accessible name collapses the sr-only " (Series)" spacer to
    // "More tools(Series)"; the name must still convey Series.
    const trigger = screen.getByRole('button', {
      name: /More tools.*Series/,
      ...SIDEBAR_QUERY,
    });
    expect(activeShapeCue(trigger)).toBeTruthy();
  });

  it('marks the active More tools route child with aria-current="page"', async () => {
    mocks.pathname = '/desktop-studio/series';
    render(
      <DesktopShell>
        <div data-testid="shell-canvas">Canvas</div>
      </DesktopShell>,
    );

    const menu = await openMoreToolsMenu(moreToolsTrigger());
    const series = within(menu).getByRole('menuitem', { name: /Series/ });
    const usage = within(menu).getByRole('menuitem', { name: /Usage & Cost/ });
    expect(series.getAttribute('aria-current')).toBe('page');
    expect(usage.getAttribute('aria-current')).toBeNull();
  });

  it('closes on Escape and restores focus to the More tools trigger', async () => {
    render(
      <DesktopShell>
        <div data-testid="shell-canvas">Canvas</div>
      </DesktopShell>,
    );

    const trigger = moreToolsTrigger();
    const menu = await openMoreToolsMenu(trigger);
    fireEvent.keyDown(menu, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('closes More tools before wide sidebar hide and does not restore focus to the trigger', async () => {
    mocks.matchMediaNarrow = false;
    render(
      <DesktopShell>
        <div data-testid="shell-canvas">Canvas</div>
      </DesktopShell>,
    );

    const trigger = moreToolsTrigger();
    await openMoreToolsMenu(trigger);
    const aside = shellAside();
    expect(aside.className).toMatch(/\blg:flex\b/);
    expect(aside.className).not.toMatch(/\blg:hidden\b/);

    invokeToggleLeft();

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    // Menu dismissal is paired with hiding the in-flow sidebar so the portal
    // cannot restore focus onto a trigger that is about to leave the layout.
    expect(aside.className).toMatch(/\blg:hidden\b/);
    expect(document.activeElement).not.toBe(trigger);
  });

  it('closes More tools before narrow drawer hide and does not restore focus to the trigger', async () => {
    mocks.matchMediaNarrow = true;
    render(
      <DesktopShell>
        <div data-testid="shell-canvas">Canvas</div>
      </DesktopShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Toggle sidebar/ }));
    await waitFor(() => {
      expect(shellAside().className).toMatch(/\btranslate-x-0\b/);
    });

    const trigger = moreToolsTrigger();
    await openMoreToolsMenu(trigger);

    invokeToggleLeft();

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    const aside = shellAside();
    expect(aside.className).toMatch(/\binvisible\b/);
    expect(aside.className).toMatch(/-translate-x-full/);
    expect(document.activeElement).not.toBe(trigger);
  });

  it('closes More tools on route change and does not restore focus to the trigger', async () => {
    const view = render(
      <DesktopShell>
        <div data-testid="shell-canvas">Canvas</div>
      </DesktopShell>,
    );

    const trigger = moreToolsTrigger();
    await openMoreToolsMenu(trigger);

    mocks.pathname = '/desktop-studio/series';
    view.rerender(
      <DesktopShell>
        <div data-testid="shell-canvas">Canvas</div>
      </DesktopShell>,
    );

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(document.activeElement).not.toBe(trigger);
  });

  it('closes More tools on max-width breakpoint change and does not restore focus to the trigger', async () => {
    mocks.matchMediaNarrow = false;
    render(
      <DesktopShell>
        <div data-testid="shell-canvas">Canvas</div>
      </DesktopShell>,
    );

    const trigger = moreToolsTrigger();
    await openMoreToolsMenu(trigger);

    fireMaxWidthBreakpointChange(true);

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(document.activeElement).not.toBe(trigger);
  });
});
