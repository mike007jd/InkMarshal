'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { BarChart3, Check, ChevronRight, Cpu, Layers, PanelLeft, Plus, Search, Settings, SlidersHorizontal, Trash2, X } from 'lucide-react';

import { useGlobalHotkeys } from '@/hooks/useGlobalHotkeys';
import { useMenuEvents } from '@/hooks/useMenuEvents';
import { cn, FOCUS_RING } from '@/lib/utils';
import { isTauriRuntime, openExternal } from '@/lib/desktop-runtime';
import {
  toggleLeftSidebar,
  toggleRightPanel,
  setNovelView,
  requestManuscriptFlush,
} from '@/lib/desktop-shell-bus';

import { DeleteNovelDialog } from '@/components/DeleteNovelDialog';
import { TrashPanel } from '@/components/TrashPanel';
import { AIActionGateCoordinator } from '@/components/AIActionGateCoordinator';
import { DesktopUpdateCoordinator } from '@/components/DesktopUpdateCoordinator';
import { VaultRuntimeCoordinator } from '@/components/VaultRuntimeCoordinator';
import { ModelsPanel } from '@/components/ModelsPanel';
import { SettingsPanel } from '@/components/SettingsPanel';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InkMarshalLogo, ManuscriptIcon } from '@/components/Icons';
import { OrnamentalDivider } from '@/components/BookOrnaments';
import { useLanguage } from '@/components/LanguageProvider';
import { useNovels } from '@/lib/use-storage';
import { useRegisterSearchScope, type NovelListScope } from '@/components/search/GlobalSearchProvider';
import {
  engineStatus,
  type EngineInfo,
} from '@/lib/desktop-runtime';
import {
  getCapabilityProfile,
  getConnections,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';
import { restoreEnginesOnLaunch } from '@/lib/model-supply/orchestrator';
import { checkConnectionHealth } from '@/lib/model-supply/runtime-health';
import { hydrateAppSettings } from '@/lib/app-settings-client';
import { subscribeLocalModelStateChanged } from '@/lib/model-supply/local-model-events';
import {
  buildCapabilityCoverageSummary,
  CAPABILITY_HEALTH_REFRESH_MS,
  collectBoundNonLocalConnections,
  EMPTY_CAPABILITY_PROFILE,
} from '@/components/models/capability-coverage';
import { roleChipLabel } from '@/components/models/model-presentation';
import {
  type CapabilityProfile,
  type RuntimeConnection,
} from '@/lib/model-supply/types';
import type { Novel } from '@/lib/db-types';
import { getSettings } from '@/lib/settings';
import { buildNovelEntryHref } from '@/lib/novel-workspace-view';
import { useRememberedNovelViews } from '@/lib/novel-workspace-preferences';

function stageBadgeClass(novel: Novel): string {
  if (novel.stage === 'completed') return 'bg-book-stage-completed';
  if (novel.stage === 'autonomous_writing') return 'bg-book-stage-writing';
  if (novel.stage === 'ready_for_greenlight') return 'bg-book-stage-ready';
  return 'bg-book-stage-default';
}

// Shared styling for the bottom workspace-nav rows (Models / Settings) — both
// are ghost buttons with the same left-aligned icon + label layout.
const WORKSPACE_NAV_ITEM_CLASS =
  'flex h-auto w-full justify-start gap-3 px-2 py-2 text-sm font-medium text-book-ink-secondary transition-feedback hover:bg-book-bg-card hover:text-book-ink-primary';

// Stable id of the off-canvas drawer so the narrow-header open button and the
// in-drawer close button can both point at it via aria-controls.
const NARROW_DRAWER_ID = 'inkmarshal-narrow-drawer';

interface DesktopShellProps {
  children: React.ReactNode;
}

export function DesktopShell({ children }: DesktopShellProps) {
  const { t, locale } = useLanguage();
  const { toast } = useToast();
  const router = useRouter();
  const params = useParams();
  const pathname = usePathname();
  const activeNovelId = (params?.id as string | undefined) ?? null;
  const rememberedNovelViews = useRememberedNovelViews();

  const { novels, loading: novelsLoading, error: novelsError, refresh, remove } = useNovels();
  const [deleteTarget, setDeleteTarget] = useState<Novel | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [runningEngines, setRunningEngines] = useState<EngineInfo[]>([]);
  const [connections, setConnections] = useState<RuntimeConnection[]>([]);
  const [capabilityProfile, setCapabilityProfile] = useState<CapabilityProfile>(EMPTY_CAPABILITY_PROFILE);
  // Non-local ready only after a successful current probe. Empty until probes
  // finish so the sidebar cannot flash 4/4 from auth/loopback shape alone.
  const [healthyConnectionModels, setHealthyConnectionModels] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const readinessSeqRef = useRef(0);
  const deletingNovelIdsRef = useRef<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Off-canvas drawer state for narrow viewports. The shell switches to this
  // drawer below 1024px (the lg breakpoint); at 1024px and above the sidebar
  // is persistent/collapsible in-flow and no scrim is rendered. The Tauri
  // window enforces a 768px minWidth, so the <1024px drawer path is a real
  // desktop state (768–1023px), not only a browser/webview preview.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const moreToolsOpenRef = useRef(false);
  const suppressMoreToolsFocusRestoreRef = useRef(false);
  const previousPathnameRef = useRef(pathname);
  const mobileNavOpenButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavCloseButtonRef = useRef<HTMLButtonElement>(null);
  const restoreMobileNavFocusRef = useRef(false);
  const settingsReturnFocusRef = useRef<HTMLElement>(null);
  const moreToolsTriggerRef = useRef<HTMLButtonElement>(null);
  const [developerTools, setDeveloperTools] = useState(() => Boolean(getSettings().developerTools));
  const closeMoreTools = useCallback((restoreFocus: boolean) => {
    // Mutate the suppress flag outside the setState updater so React 19
    // concurrent re-runs cannot apply the side effect twice (or skip it).
    if (moreToolsOpenRef.current && !restoreFocus) {
      suppressMoreToolsFocusRestoreRef.current = true;
    }
    moreToolsOpenRef.current = false;
    setMoreToolsOpen(false);
  }, []);
  const closeMobileNavigation = useCallback(() => {
    closeMoreTools(false);
    restoreMobileNavFocusRef.current = true;
    setMobileNavOpen(false);
  }, [closeMoreTools]);
  const toggleMobileNavigation = useCallback(() => {
    if (mobileNavOpen) {
      closeMoreTools(false);
      restoreMobileNavFocusRef.current = true;
    }
    setMobileNavOpen(open => !open);
  }, [closeMoreTools, mobileNavOpen]);

  useEffect(() => {
    const refreshDeveloperTools = () => setDeveloperTools(Boolean(getSettings().developerTools));
    window.addEventListener('inkmarshal:settings-changed', refreshDeveloperTools);
    return () => window.removeEventListener('inkmarshal:settings-changed', refreshDeveloperTools);
  }, []);

  // Close the mobile drawer / More tools portal on route change so navigating
  // to a novel / Models page reveals the main pane. Path guard keeps the first
  // mount and effect re-runs from dismissing an unrelated open menu.
  useEffect(() => {
    if (previousPathnameRef.current === pathname) return;
    previousPathnameRef.current = pathname;
    closeMoreTools(false);
    setMobileNavOpen(false);
  }, [closeMoreTools, pathname]);

  useEffect(() => {
    const breakpoint = window.matchMedia('(max-width: 1023px)');
    const closeAtBreakpoint = () => closeMoreTools(false);
    breakpoint.addEventListener('change', closeAtBreakpoint);
    return () => breakpoint.removeEventListener('change', closeAtBreakpoint);
  }, [closeMoreTools]);
  useEffect(() => {
    if (mobileNavOpen) {
      mobileNavCloseButtonRef.current?.focus();
      return;
    }
    if (!restoreMobileNavFocusRef.current) return;
    restoreMobileNavFocusRef.current = false;
    mobileNavOpenButtonRef.current?.focus();
  }, [mobileNavOpen]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape') return;
      event.preventDefault();
      closeMobileNavigation();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [closeMobileNavigation, mobileNavOpen]);

  useEffect(() => {
    let mounted = true;
    let readinessEnabled = false;
    let initializationPromise: Promise<void> | null = null;
    const refreshReadiness = (invalidateNonLocal = false) => void (async () => {
      if (!readinessEnabled) return;
      const seq = ++readinessSeqRef.current;
      const configuredConnections = getConnections();
      const profile = getCapabilityProfile();
      // A connection/profile mutation can reuse an id for a different endpoint,
      // so invalidate immediately. Periodic/focus probes keep the last confirmed
      // result until their replacement arrives to avoid a visible 60s flicker.
      if (invalidateNonLocal) setHealthyConnectionModels(new Map());
      const engines = await engineStatus().catch(() => [] as EngineInfo[]);
      if (!mounted || readinessSeqRef.current !== seq) return;
      setConnections(configuredConnections);
      setCapabilityProfile(profile);
      setRunningEngines(engines);

      const probeTargets = collectBoundNonLocalConnections(profile, configuredConnections);
      const nextHealthy = new Map<string, ReadonlySet<string>>();
      await Promise.all(
        probeTargets.map(async connection => {
          const health = await checkConnectionHealth(connection);
          if (health.reachable && health.transportOk) {
            nextHealthy.set(connection.id, new Set(health.models));
          }
        }),
      );
      if (!mounted || readinessSeqRef.current !== seq) return;
      setHealthyConnectionModels(nextHealthy);
    })();
    const initializeReadiness = (): void => {
      if (readinessEnabled || initializationPromise) return;
      const request = (async () => {
        const result = await hydrateAppSettings();
        if (!mounted || !result.ok) return;
        // Hydration makes connection endpoints authoritative. Restore local
        // child processes before the first readiness paint; a restore failure
        // still leaves provider probing safe and dead local engines truthful.
        await restoreEnginesOnLaunch().catch(() => undefined);
        if (!mounted) return;
        readinessEnabled = true;
        refreshReadiness(true);
      })().finally(() => {
        if (initializationPromise === request) initializationPromise = null;
      });
      initializationPromise = request;
    };
    // Durable config (connections, capability bindings, engine launch plans)
    // lives in SQLite now. Hydrate it BEFORE restoreEnginesOnLaunch reads those
    // stores: after a runtime-port change the localStorage mirror is empty, and
    // restoring from it would silently drop the user's engines/bindings.
    // Local engines die with the app process, so relaunch what was running at
    // last quit (and prune dead bindings) before the first readiness read so
    // the shell never paints a zombie "bound but dead" state on boot.
    // A failed hydrate must not restore from the unauthoritative first-paint
    // mirror. Focus/online later retrigger the bounded hydration attempt.
    initializeReadiness();
    const unsubscribeConnections = subscribeConnectionsStore(() => {
      if (readinessEnabled) refreshReadiness(true);
      else initializeReadiness();
    });
    const unsubscribeLocalModels = subscribeLocalModelStateChanged(() => {
      if (readinessEnabled) refreshReadiness();
      else initializeReadiness();
    });
    const retry = () => {
      if (readinessEnabled) refreshReadiness();
      else initializeReadiness();
    };
    window.addEventListener('focus', retry);
    window.addEventListener('online', retry);
    const healthInterval = window.setInterval(retry, CAPABILITY_HEALTH_REFRESH_MS);
    return () => {
      mounted = false;
      unsubscribeConnections();
      unsubscribeLocalModels();
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
      window.clearInterval(healthInterval);
    };
  }, []);

  const modelCoverage = useMemo(
    () => buildCapabilityCoverageSummary({
      profile: capabilityProfile,
      connections,
      runningEngines,
      healthyConnectionModels,
    }),
    [capabilityProfile, connections, runningEngines, healthyConnectionModels],
  );
  const modelCoverageLabel = t.modelReadinessCoverage
    .replace('{ready}', String(modelCoverage.readyCount))
    .replace('{total}', String(modelCoverage.totalCount));
  const modelCoverageTooltip = modelCoverage.complete
    ? t.modelReadinessCoverageComplete
    : t.modelReadinessCoverageTooltip
        .replace('{ready}', String(modelCoverage.readyCount))
        .replace('{total}', String(modelCoverage.totalCount))
        .replace(
          '{roles}',
          modelCoverage.notReadyRoles.map(role => roleChipLabel(role, t)).join(', '),
        );

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        if (cancelled) return;
        await invoke('write_app_locale', { locale });
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('Failed to persist locale for menu:', err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const searchScope = useMemo<NovelListScope>(() => ({
    kind: 'novel-list',
    id: 'desktop:novel-list',
    items: novels.map(n => ({
      novelId: n.id,
      title: n.title || t.untitledNovel,
    })),
    onJump: (novelId, chapterNumber, offset) => {
      if (chapterNumber) {
        const search = new URLSearchParams({
          view: 'read-edit',
          chapter: String(chapterNumber),
        });
        if (offset !== undefined) search.set('offset', String(offset));
        router.push(`/novel/${novelId}?${search.toString()}`);
        return;
      }
      router.push(buildNovelEntryHref(novelId, rememberedNovelViews[novelId]));
    },
  }), [novels, rememberedNovelViews, router, t.untitledNovel]);
  useRegisterSearchScope(searchScope);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    if (deletingNovelIdsRef.current.has(id)) return;
    deletingNovelIdsRef.current.add(id);
    setDeleteTarget(null);
    try {
      const deleted = await remove(id);
      if (!deleted) {
        toast(t.errorDeleteNovel, 'error');
        return;
      }
      if (activeNovelId === id) {
        router.push('/desktop-studio');
      }
      toast(t.moveToTrashSuccess.replace('{title}', deleteTarget.title), 'success');
    } finally {
      deletingNovelIdsRef.current.delete(id);
    }
  };

  const openCreate = useCallback(() => {
    router.push('/desktop-studio');
  }, [router]);

  const handleMenuAction = useCallback((id: string) => {
    switch (id) {
      case 'inkmarshal.file.new':
        void openCreate();
        return;
      case 'inkmarshal.file.save':
        // Save is silent on success and also captures the persisted chapter as
        // a snapshot. The editor surfaces either failure explicitly.
        void requestManuscriptFlush({ createSnapshot: true });
        return;
      case 'inkmarshal.file.export':
        window.dispatchEvent(new CustomEvent('inkmarshal:export-bundle'));
        return;
      case 'inkmarshal.file.closeWindow':
        void (async () => {
          if (!isTauriRuntime()) return;
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().close();
          } catch (err) {
            if (typeof console !== 'undefined') {
              console.warn('Failed to close window:', err);
            }
          }
        })();
        return;
      case 'inkmarshal.edit.find':
        window.dispatchEvent(new CustomEvent('inkmarshal:open-find'));
        return;
      case 'inkmarshal.view.chat':
        setNovelView('agent');
        return;
      case 'inkmarshal.view.knowledge':
        setNovelView('story-deck');
        return;
      case 'inkmarshal.view.conv':
        setNovelView('agent');
        return;
      case 'inkmarshal.view.manuscript':
        setNovelView('read-edit');
        return;
      case 'inkmarshal.view.toggleLeft':
        if (showSettings || showTrash) return;
        closeMoreTools(false);
        if (window.matchMedia('(max-width: 1023px)').matches) {
          toggleMobileNavigation();
        } else {
          setSidebarOpen(prev => !prev);
        }
        toggleLeftSidebar();
        return;
      case 'inkmarshal.view.toggleRight':
        toggleRightPanel();
        return;
      case 'inkmarshal.models':
        router.push('/desktop-studio/models');
        return;
      case 'inkmarshal.prefs':
        if (showSettings) return;
        settingsReturnFocusRef.current =
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== document.body
            ? document.activeElement
            : null;
        setShowSettings(true);
        return;
      case 'inkmarshal.window.minimize':
        void (async () => {
          if (!isTauriRuntime()) return;
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().minimize();
          } catch (err) {
            if (typeof console !== 'undefined') {
              console.warn('Failed to minimize window:', err);
            }
          }
        })();
        return;
      case 'inkmarshal.help.docs':
        void (async () => {
          try {
            await openExternal('https://github.com/mike007jd/InkMarshal');
          } catch (err) {
            if (typeof console !== 'undefined') {
              console.warn('Failed to open docs:', err);
            }
          }
        })();
        return;
      case 'inkmarshal.help.report':
        void (async () => {
          try {
            await openExternal('https://github.com/mike007jd/InkMarshal/issues/new');
          } catch (err) {
            if (typeof console !== 'undefined') {
              console.warn('Failed to open issues page:', err);
            }
          }
        })();
        return;
      default:
        return;
    }
  }, [closeMoreTools, openCreate, router, showSettings, showTrash, toggleMobileNavigation]);

  useMenuEvents(handleMenuAction);
  useGlobalHotkeys(handleMenuAction, { enabled: isTauriRuntime() });

  const activeMoreToolLabel = pathname.startsWith('/desktop-studio/workflows')
    ? t.navWorkflows
    : pathname.startsWith('/desktop-studio/series')
      ? t.navSeries
      : pathname.startsWith('/desktop-studio/usage')
        ? t.navUsage
        : null;

  return (
    <div className="flex h-screen min-h-0 w-full overflow-hidden">
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-30 bg-book-ink-primary/30 lg:hidden"
          onClick={closeMobileNavigation}
          aria-hidden
        />
      )}
      <aside
        id={NARROW_DRAWER_ID}
        className={cn(
          'z-40 flex w-64 shrink-0 flex-col border-r border-book-border bg-book-bg-sidebar text-book-ink-primary lg:shadow-none',
          'fixed inset-y-0 left-0 transform transition-layout lg:static lg:translate-x-0 lg:transition-none',
          mobileNavOpen
            ? 'visible translate-x-0 shadow-overlay'
            : 'invisible -translate-x-full lg:visible',
          sidebarOpen ? 'lg:flex' : 'lg:hidden',
        )}
      >
        {/* 28px drag region at the top of the sidebar — the macOS traffic
            lights live here (overlay title bar). pt-7 keeps the logo clear
            of the buttons. */}
        <div
          data-tauri-drag-region
          className="h-7 shrink-0"
          aria-hidden
        />
        <div className="relative">
          <Link
            href="/desktop-studio"
            className={`flex items-center gap-3 px-6 pb-6 pt-2 font-serif text-xl text-book-ink-primary hover:text-book-ink-primary ${FOCUS_RING}`}
          >
            <InkMarshalLogo className="h-7 w-7 text-book-gold" />
            <span className="tracking-tight">{t.appName}</span>
          </Link>
          {/* In-drawer close control. The fixed drawer overlays the narrow
              header's open button, so the only pointer-reachable toggle while
              open must live inside the drawer layer itself. Rendered only
              while the drawer is open so there is exactly one accessible
              toggle target per state, and anchored to the right of the logo
              row so it clears the macOS traffic-light drag region above and
              never covers the logo/title. */}
          {mobileNavOpen && (
            <Button
              ref={mobileNavCloseButtonRef}
              variant="ghost"
              size="icon"
              type="button"
              onClick={closeMobileNavigation}
              aria-controls={NARROW_DRAWER_ID}
              aria-expanded={true}
              aria-label={t.toggleSidebar}
              className="absolute right-3 top-2 text-book-ink-secondary hover:text-book-ink-primary lg:hidden"
            >
              <X className="h-5 w-5" />
            </Button>
          )}
        </div>
        <OrnamentalDivider className="px-6" />

        <div className="space-y-2 p-4">
          <Button
            variant="book"
            size="md"
            onClick={openCreate}
            className="flex w-full px-4 py-2.5 h-auto"
          >
            <Plus className="h-4 w-4" />
            {t.newNovel}
          </Button>
          {/* Visible entry point for global search — previously reachable only
              via the native Edit→Find menu / ⌘F, so first-time users never knew
              it existed. Dispatches the same event the menu emits. */}
          <Button
            variant="unstyled"
            size="unstyled"
            type="button"
            onClick={() => window.dispatchEvent(new Event('inkmarshal:open-find'))}
            className="flex w-full items-center gap-2 border border-book-border bg-book-bg-card/60 px-3 py-2 text-sm text-book-ink-muted transition-feedback hover:border-book-gold hover:text-book-ink-secondary"
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">{t.searchAction}</span>
            <kbd className="rounded border border-book-border px-1.5 py-0.5 text-2xs font-medium text-book-ink-muted">⌘K</kbd>
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          <div className="mb-3 px-5 text-xs font-semibold text-book-ink-secondary">
            {t.yourProjects}
          </div>
          <div className="space-y-1 px-3">
            {novels.map(novel => {
              const isActive = novel.id === activeNovelId;
              return (
                <div
                  key={novel.id}
                  className={`group flex items-center gap-2 rounded-lg border px-3 py-2.5 transition-feedback ${
                    isActive
                      ? 'border-book-gold/30 bg-book-bg-card/70 text-book-ink-primary'
                      : 'border-transparent text-book-ink-secondary hover:bg-book-bg-card/50 hover:text-book-ink-primary'
                  }`}
                >
                  <Link
                    href={isActive
                      ? pathname
                      : buildNovelEntryHref(novel.id, rememberedNovelViews[novel.id])}
                    onClick={isActive ? event => event.preventDefault() : undefined}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex min-w-0 flex-1 items-center gap-3 ${FOCUS_RING}`}
                  >
                    <ManuscriptIcon
                      className={`h-4 w-4 shrink-0 ${isActive ? 'text-book-gold' : 'text-book-ink-muted'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium" title={novel.title}>{novel.title}</div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${stageBadgeClass(novel)}`} />
                        <span className="truncate text-xs-tight text-book-ink-muted">
                          {t.stages[novel.stage]}
                        </span>
                      </div>
                    </div>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    onClick={() => setDeleteTarget(novel)}
                    className="h-auto w-auto rounded p-2 text-book-ink-muted opacity-0 transition-feedback hover:bg-book-bg-secondary hover:text-book-danger group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`${t.moveToTrashAction} ${novel.title}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
            {novelsLoading && novels.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-book-ink-secondary">
                {t.loading || 'Loading'}
              </div>
            )}
            {!novelsLoading && novelsError && novels.length === 0 && (
              <div className="flex flex-col items-center gap-3 px-3 py-6 text-center">
                <p className="text-sm text-book-danger">{t.errorLoadProjects}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
                  {t.toastRetry}
                </Button>
              </div>
            )}
            {!novelsLoading && !novelsError && novels.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-book-ink-secondary">
                {t.noNovels}
              </div>
            )}
          </div>
        </div>

        {/* Frequent workspace controls stay visible; specialist tools use
            progressive disclosure so writing remains the shell's center. */}
        <div className="mt-auto border-t border-book-border bg-book-bg-sidebar px-4 py-3">
          <div className="mb-2 px-1 text-xs font-semibold text-book-ink-secondary">
            {t.workspaceTools}
          </div>
          <div className="flex flex-col gap-1">
            <Button variant="ghost" asChild className={WORKSPACE_NAV_ITEM_CLASS}>
              <Link href="/desktop-studio/models">
                <Cpu className="h-4 w-4 text-book-ink-muted" />
                <span className="flex-1">{t.navModels}</span>
                <span
                  className={cn(
                    'shrink-0 rounded border px-1.5 py-0.5 text-xs font-semibold leading-none',
                    modelCoverage.complete
                      ? 'border-book-success/40 bg-book-success/10 text-book-success'
                      : 'border-book-gold/50 bg-book-gold/10 text-book-gold-dark',
                  )}
                  aria-label={modelCoverageTooltip}
                  title={modelCoverageTooltip}
                >
                  {modelCoverageLabel}
                </span>
              </Link>
            </Button>
            <Button
              variant="ghost"
              onClick={event => {
                settingsReturnFocusRef.current = event.currentTarget;
                setShowSettings(true);
              }}
              className={WORKSPACE_NAV_ITEM_CLASS}
            >
              <Settings className="h-4 w-4 text-book-ink-muted" />
              {t.settings}
            </Button>
            <DropdownMenu
              open={moreToolsOpen}
              onOpenChange={open => {
                if (open) suppressMoreToolsFocusRestoreRef.current = false;
                moreToolsOpenRef.current = open;
                setMoreToolsOpen(open);
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  ref={moreToolsTriggerRef}
                  variant="ghost"
                  className={cn(
                    `${WORKSPACE_NAV_ITEM_CLASS} group`,
                    activeMoreToolLabel && 'bg-book-bg-card/70 text-book-ink-primary',
                  )}
                >
                  <SlidersHorizontal
                    className={cn('h-4 w-4', activeMoreToolLabel ? 'text-book-gold' : 'text-book-ink-muted')}
                  />
                  <span className="flex-1 text-left">
                    {t.moreTools}
                    {activeMoreToolLabel && (
                      <span className="sr-only">{` (${activeMoreToolLabel})`}</span>
                    )}
                  </span>
                  {activeMoreToolLabel && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-book-gold" aria-hidden />
                  )}
                  <ChevronRight className="h-3.5 w-3.5 text-book-ink-muted" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="start"
                sideOffset={8}
                className="w-56"
                onCloseAutoFocus={event => {
                  if (!suppressMoreToolsFocusRestoreRef.current) return;
                  suppressMoreToolsFocusRestoreRef.current = false;
                  event.preventDefault();
                }}
              >
                <DropdownMenuLabel>{t.moreTools}</DropdownMenuLabel>
                {developerTools && (
                  <DropdownMenuItem asChild onSelect={() => closeMoreTools(false)}>
                    <Link
                      href="/desktop-studio/workflows"
                      aria-current={pathname.startsWith('/desktop-studio/workflows') ? 'page' : undefined}
                    >
                      <SlidersHorizontal className="h-4 w-4 text-book-ink-muted" />
                      <span className="flex-1">{t.navWorkflows}</span>
                      {pathname.startsWith('/desktop-studio/workflows') && (
                        <Check className="h-4 w-4 text-book-gold" aria-hidden />
                      )}
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild onSelect={() => closeMoreTools(false)}>
                  <Link
                    href="/desktop-studio/series"
                    aria-current={pathname.startsWith('/desktop-studio/series') ? 'page' : undefined}
                  >
                    <Layers className="h-4 w-4 text-book-ink-muted" />
                    <span className="flex-1">{t.navSeries}</span>
                    {pathname.startsWith('/desktop-studio/series') && (
                      <Check className="h-4 w-4 text-book-gold" aria-hidden />
                    )}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    closeMoreTools(false);
                    setShowTrash(true);
                  }}
                >
                  <Trash2 className="h-4 w-4 text-book-ink-muted" />
                  <span className="flex-1">{t.trashTitle}</span>
                </DropdownMenuItem>
                <DropdownMenuItem asChild onSelect={() => closeMoreTools(false)}>
                  <Link
                    href="/desktop-studio/usage"
                    aria-current={pathname.startsWith('/desktop-studio/usage') ? 'page' : undefined}
                  >
                    <BarChart3 className="h-4 w-4 text-book-ink-muted" />
                    <span className="flex-1">{t.navUsage}</span>
                    {pathname.startsWith('/desktop-studio/usage') && (
                      <Check className="h-4 w-4 text-book-gold" aria-hidden />
                    )}
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div
          data-tauri-drag-region
          className="h-7 shrink-0 bg-book-bg-primary"
          aria-hidden
        />
        {/* Narrow-viewport top bar with the drawer toggle. Hidden at lg+
            where the sidebar is in-flow, so the desktop chrome is unchanged. */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-book-border bg-book-bg-primary px-3 lg:hidden">
          {/* Open control, rendered only while the drawer is closed: once the
              fixed drawer is open it covers this header, so a toggle here
              could never be clicked a second time. The in-drawer close
              button takes over while open, keeping exactly one truthful
              accessible toggle target per state. */}
          {!mobileNavOpen && (
            <Button
              ref={mobileNavOpenButtonRef}
              variant="ghost"
              size="icon"
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-controls={NARROW_DRAWER_ID}
              aria-expanded={false}
              aria-label={t.toggleSidebar}
              className="text-book-ink-secondary hover:text-book-ink-primary"
            >
              <PanelLeft className="h-5 w-5" />
            </Button>
          )}
          <span className="font-hand text-lg text-book-ink-primary">{t.appName}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {children}
        </div>
        <div id="toast-anchor" className="pointer-events-none absolute inset-0 z-[90]" aria-hidden />
      </main>

       <DeleteNovelDialog
        open={deleteTarget !== null}
        title={deleteTarget?.title || ''}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
       />
       <AIActionGateCoordinator />
       <DesktopUpdateCoordinator />
       <VaultRuntimeCoordinator />
       <ModelsPanel open={false} />
      <SettingsPanel
        open={showSettings}
        onClose={() => setShowSettings(false)}
        fallbackFocusRef={mobileNavOpenButtonRef}
        returnFocusRef={settingsReturnFocusRef}
      />
      <TrashPanel
        open={showTrash}
        onOpenChange={setShowTrash}
        onLibraryChange={() => void refresh()}
        returnFocusRef={moreToolsTriggerRef}
        fallbackFocusRef={mobileNavOpenButtonRef}
      />
    </div>
  );
}
