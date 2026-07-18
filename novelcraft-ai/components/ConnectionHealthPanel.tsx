'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MonitorCheck, RefreshCw } from 'lucide-react';

import { useLanguage } from '@/components/LanguageProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  engineStatus,
  getDesktopStatus,
} from '@/lib/desktop-runtime';
import type { EngineInfo } from '@/lib/desktop-runtime';
import {
  getConnections,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';
import { checkConnectionHealth } from '@/lib/model-supply/runtime-health';
import type { ConnectionHealth, RuntimeConnection } from '@/lib/model-supply/types';

interface HealthRow {
  connection: RuntimeConnection;
  health: ConnectionHealth | null;
}

function modelBasename(modelPath: string): string {
  return modelPath.split(/[/\\]/).filter(Boolean).pop() ?? modelPath;
}

/**
 * Connection health diagnostics for the Settings drawer. Shows the bundled
 * engine plus any user-configured runtime connections — no longer probes a
 * synthetic Ollama default, since the app no longer recommends Ollama.
 */
export function ConnectionHealthPanel() {
  const { t } = useLanguage();
  const [rows, setRows] = useState<HealthRow[]>([]);
  const [engineInfos, setEngineInfos] = useState<EngineInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [desktop, setDesktop] = useState(false);

  const mountedRef = useRef(true);
  const refreshSeqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const [st, engines] = await Promise.all([
        getDesktopStatus(),
        engineStatus().catch(() => [] as EngineInfo[]),
      ]);

      if (mountedRef.current && refreshSeqRef.current === seq) {
        setDesktop(st.desktop);
        setEngineInfos(engines);
      }

      const configured = getConnections();
      if (mountedRef.current && refreshSeqRef.current === seq) {
        setRows(configured.map(connection => ({ connection, health: null })));
      }

      const results = await Promise.all(
        configured.map(async connection => ({
          connection,
          health: await checkConnectionHealth(connection),
        })),
      );
      if (mountedRef.current && refreshSeqRef.current === seq) setRows(results);
    } finally {
      if (mountedRef.current && refreshSeqRef.current === seq) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    const unsubscribe = subscribeConnectionsStore(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [refresh]);

  const bundledRunning = engineInfos.length > 0;

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <MonitorCheck className="h-3.5 w-3.5 text-book-ink-muted" />
        <h3 className="flex-1 text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
          {t.desktopRuntimeTitle}
        </h3>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => void refresh()}
          disabled={loading}
          aria-label={t.desktopRuntimeRefresh}
          title={t.desktopRuntimeRefresh}
        >
          {loading ? <Spinner size="sm" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      <div className="space-y-2">
        <p className="text-xs leading-5 text-book-ink-muted">
          {desktop ? t.desktopRuntimeDesktopHint : t.desktopRuntimeWebHint}
        </p>

        <div
          className="rounded-md border border-book-border px-3 py-2"
          role="status"
          aria-label={t.runtimeEngineBundled}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium text-book-ink-primary">
                {t.runtimeEngineBundled}
              </div>
              {bundledRunning && (
                <div className="truncate text-xs-tight text-book-ink-muted">
                  {modelBasename(engineInfos[0].modelPath)} &middot; :{engineInfos[0].port}
                </div>
              )}
            </div>
            {loading ? (
              <Badge variant="muted">{t.statusBarHealthChecking}</Badge>
            ) : bundledRunning ? (
              <Badge variant="success">{t.desktopRuntimeReady}</Badge>
            ) : (
              <Badge variant="muted">{t.desktopRuntimeMissing}</Badge>
            )}
          </div>

          {bundledRunning && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs-tight text-book-ink-muted">
              <span className="uppercase tracking-wide">
                {engineInfos[0].format}
              </span>
              {engineInfos.length > 1 && (
                <span>+{engineInfos.length - 1}</span>
              )}
            </div>
          )}
        </div>

        {rows.length > 0 && (
          <p className="pt-1 text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
            {t.runtimeAlsoDetected}
          </p>
        )}

        <TooltipProvider>
          {rows.map(({ connection, health }) => {
            const ok = health?.reachable && health?.transportOk;
            return (
              <div
                key={connection.id}
                className="rounded-md border border-book-border px-3 py-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {/* Label is the hover trigger; the verbose URL + port
                            moves to the tooltip so the row stays compact (W4-G). */}
                        <Button
                          variant="unstyled"
                          size="unstyled"
                          type="button"
                          className="max-w-full justify-start truncate text-left text-xs font-medium text-book-ink-primary hover:underline"
                        >
                          {connection.label}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <div className="space-y-0.5 text-xs-tight">
                          <div className="font-mono text-book-ink-secondary">
                            {connection.baseUrl}
                          </div>
                          {connection.kind === 'local' && health?.models.length ? (
                            <div className="text-book-ink-muted">
                              {t.desktopRuntimeDetected.replace(
                                '{count}',
                                String(health.models.length),
                              )}
                            </div>
                          ) : null}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {health == null ? (
                    <Badge variant="muted">{t.statusBarHealthChecking}</Badge>
                  ) : ok ? (
                    <Badge variant="success">{t.desktopRuntimeReady}</Badge>
                  ) : (
                    <Badge variant="danger">{t.desktopRuntimeUnavailable}</Badge>
                  )}
                </div>

                {health != null && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs-tight text-book-ink-muted">
                    {ok && (
                      <>
                        <span>
                          {t.desktopRuntimeDetected.replace(
                            '{count}',
                            String(health.models.length),
                          )}
                        </span>
                        {health.latencyMs > 0 && <span>{health.latencyMs} ms</span>}
                      </>
                    )}
                    {!ok && health.message && (
                      <span className="text-book-ink-secondary">
                        {health.message}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </TooltipProvider>
      </div>
    </section>
  );
}
