'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { BarChart3, ChevronDown, Cpu, Layers, PanelLeft, Plus, Search, Settings, SlidersHorizontal, Trash2 } from 'lucide-react';

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
import { ModelsPanel } from '@/components/ModelsPanel';
import { SettingsPanel } from '@/components/SettingsPanel';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
import { hydrateAppSettings } from '@/lib/app-settings-client';
import { subscribeLocalModelStateChanged } from '@/lib/model-supply/local-model-events';
import {
  buildCapabilityCoverageSummary,
  EMPTY_CAPABILITY_PROFILE,
} from '@/components/models/capability-coverage';
import { roleChipLabel } from '@/components/models/model-presentation';
import type { CapabilityProfile, RuntimeConnection } from '@/lib/model-supply/types';
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
  const readinessSeqRef = useRef(0);
  const deletingNovelIdsRef = useRef<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Off-canvas drawer state for narrow viewports (browser/webview preview;
  // the Tauri window enforces a 1040px minWidth so this is a safety net for
  // any constrained desktop webview where the fixed sidebar would crush the
  // main pane).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [developerTools, setDeveloperTools] = useState(() => Boolean(getSettings().developerTools));

  useEffect(() => {
    const refreshDeveloperTools = () => setDeveloperTools(Boolean(getSettings().developerTools));
    window.addEventListener('inkmarshal:settings-changed', refreshDeveloperTools);
    return () => window.removeEventListener('inkmarshal:settings-changed', refreshDeveloperTools);
  }, []);

  // Close the mobile drawer whenever the route changes so navigating to a
  // novel / Models page reveals the main pane instead of leaving the overlay
  // covering it. Adjusted during render (React's "store info from previous
  // renders" pattern) rather than in an effect.
  const [drawerPathname, setDrawerPathname] = useState(pathname);
  if (pathname !== drawerPathname) {
    setDrawerPathname(pathname);
    if (mobileNavOpen) setMobileNavOpen(false);
  }

  useEffect(() => {
    let mounted = true;
    const refreshReadiness = () => void (async () => {
      const seq = ++readinessSeqRef.current;
      const configuredConnections = getConnections();
      const profile = getCapabilityProfile();
      const engines = await engineStatus().catch(() => [] as EngineInfo[]);
      if (!mounted || readinessSeqRef.current !== seq) return;
      setConnections(configuredConnections);
      setCapabilityProfile(profile);
      setRunningEngines(engines);
    })();
    // Durable config (connections, capability bindings, engine launch plans)
    // lives in SQLite now. Hydrate it BEFORE restoreEnginesOnLaunch reads those
    // stores: after a runtime-port change the localStorage mirror is empty, and
    // restoring from it would silently drop the user's engines/bindings.
    // Local engines die with the app process, so relaunch what was running at
    // last quit (and prune dead bindings) before the first readiness read so
    // the shell never paints a zombie "bound but dead" state on boot.
    void (async () => {
      await hydrateAppSettings();
      if (!mounted) return;
      await restoreEnginesOnLaunch();
      if (mounted) refreshReadiness();
    })();
    refreshReadiness();
    const unsubscribeConnections = subscribeConnectionsStore(refreshReadiness);
    const unsubscribeLocalModels = subscribeLocalModelStateChanged(refreshReadiness);
    return () => {
      mounted = false;
      unsubscribeConnections();
      unsubscribeLocalModels();
    };
  }, []);

  const modelCoverage = useMemo(
    () => buildCapabilityCoverageSummary({
      profile: capabilityProfile,
      connections,
      runningEngines,
    }),
    [capabilityProfile, connections, runningEngines],
  );
  const modelCoverageLabel = t.modelReadinessCoverage
    .replace('{ready}', String(modelCoverage.readyCount))
    .replace('{total}', String(modelCoverage.totalCount));
  const missingModelRolesLabel = modelCoverage.notReadyRoles
    .map(role => roleChipLabel(role, t))
    .join(', ');
  const modelCoverageTooltip = modelCoverage.complete
    ? t.modelReadinessCoverageComplete
    : t.modelReadinessCoverageTooltip
        .replace('{ready}', String(modelCoverage.readyCount))
        .replace('{total}', String(modelCoverage.totalCount))
        .replace('{roles}', missingModelRolesLabel);

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
        if (window.matchMedia('(max-width: 1279px)').matches) {
          setMobileNavOpen(prev => !prev);
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
  }, [openCreate, router]);

  useMenuEvents(handleMenuAction);
  useGlobalHotkeys(handleMenuAction, { enabled: isTauriRuntime() });

  return (
    <div className="flex h-screen min-h-0 w-full overflow-hidden">
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-30 bg-book-ink-primary/30 xl:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={cn(
          'z-40 flex w-64 shrink-0 flex-col border-r border-book-border bg-book-bg-sidebar text-book-ink-primary',
          'fixed inset-y-0 left-0 transform transition-layout xl:static xl:translate-x-0 xl:transition-none',
          mobileNavOpen
            ? 'visible translate-x-0 shadow-overlay'
            : 'invisible -translate-x-full xl:visible xl:shadow-none',
          sidebarOpen ? 'xl:flex' : 'xl:hidden',
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
        <Link
          href="/desktop-studio"
          className={`flex items-center gap-3 px-6 pb-6 pt-2 font-serif text-xl text-book-ink-primary hover:text-book-ink-primary ${FOCUS_RING}`}
        >
          <InkMarshalLogo className="h-7 w-7 text-book-gold" />
          <span className="tracking-tight">{t.appName}</span>
        </Link>
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
              onClick={() => setShowSettings(true)}
              className={WORKSPACE_NAV_ITEM_CLASS}
            >
              <Settings className="h-4 w-4 text-book-ink-muted" />
              {t.settings}
            </Button>
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" className={`${WORKSPACE_NAV_ITEM_CLASS} group`}>
                  <SlidersHorizontal className="h-4 w-4 text-book-ink-muted" />
                  <span className="flex-1 text-left">{t.moreTools}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-book-ink-muted transition-toggle group-data-[state=open]:rotate-180" />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="ml-3 mt-1 border-l border-book-border pl-2">
                 {developerTools && (
                   <Button variant="ghost" asChild className={WORKSPACE_NAV_ITEM_CLASS}>
                     <Link href="/desktop-studio/workflows">
                       <SlidersHorizontal className="h-4 w-4 text-book-ink-muted" />
                       <span className="flex-1">{t.navWorkflows}</span>
                     </Link>
                   </Button>
                 )}
                <Button variant="ghost" asChild className={WORKSPACE_NAV_ITEM_CLASS}>
                  <Link href="/desktop-studio/series">
                    <Layers className="h-4 w-4 text-book-ink-muted" />
                    <span className="flex-1">{t.navSeries}</span>
                  </Link>
                </Button>
                <Button variant="ghost" className={WORKSPACE_NAV_ITEM_CLASS} onClick={() => setShowTrash(true)}>
                  <Trash2 className="h-4 w-4 text-book-ink-muted" />
                  <span className="flex-1 text-left">{t.trashTitle}</span>
                </Button>
                <Button variant="ghost" asChild className={WORKSPACE_NAV_ITEM_CLASS}>
                  <Link href="/desktop-studio/usage">
                    <BarChart3 className="h-4 w-4 text-book-ink-muted" />
                    <span className="flex-1">{t.navUsage}</span>
                  </Link>
                </Button>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>

      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div
          data-tauri-drag-region
          className="h-7 shrink-0 bg-book-bg-primary"
          aria-hidden
        />
        {/* Narrow-viewport top bar with the drawer toggle. Hidden at xl+ where
            the sidebar is always in-flow, so the desktop chrome is unchanged. */}
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-book-border bg-book-bg-primary px-3 xl:hidden">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label={t.toggleSidebar}
            className="text-book-ink-secondary hover:text-book-ink-primary"
          >
            <PanelLeft className="h-5 w-5" />
          </Button>
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
       <ModelsPanel open={false} />
      <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />
      <TrashPanel open={showTrash} onOpenChange={setShowTrash} onLibraryChange={() => void refresh()} />
    </div>
  );
}
