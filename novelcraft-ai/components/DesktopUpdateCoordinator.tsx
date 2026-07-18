'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, X } from 'lucide-react';
import type { Update } from '@tauri-apps/plugin-updater';

import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { requestSaveNow } from '@/lib/desktop-shell-bus';
import { isTauriRuntime } from '@/lib/desktop-runtime';
import { isCriticalDesktopUpdate, updateProgressPercent } from '@/lib/desktop-updates';
import {
  DESKTOP_UPDATE_MANUAL_CHECK_EVENT,
  isAutomaticUpdateCheckEnabled,
  publishDesktopUpdateCheckResult,
} from '@/lib/desktop-update-preferences';

const STARTUP_CHECK_DELAY_MS = 8_000;

export function DesktopUpdateCoordinator() {
  const { t } = useLanguage();
  const [update, setUpdate] = useState<Update | null>(null);
  const [critical, setCritical] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateRef = useRef<Update | null>(null);
  const downloadedRef = useRef(0);
  const totalBytesRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let checking = false;

    const checkForUpdate = async (source: 'startup' | 'manual') => {
      if (checking) return;
      checking = true;
      if (source === 'manual') publishDesktopUpdateCheckResult('checking');
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const result = await check({ timeout: 12_000 });
        if (disposed) {
          void result?.close();
          return;
        }
        if (result === null) {
          if (source === 'manual') publishDesktopUpdateCheckResult('up-to-date');
          return;
        }
        setCritical(isCriticalDesktopUpdate(result));
        updateRef.current = result;
        setUpdate(result);
        if (source === 'manual') publishDesktopUpdateCheckResult('update-available');
      } catch {
        // Startup checks remain silent so a temporary network failure never
        // interrupts local writing. Manual checks report the failure in Settings.
        if (!disposed && source === 'manual') publishDesktopUpdateCheckResult('failed');
      } finally {
        checking = false;
      }
    };

    const handleManualCheck = () => void checkForUpdate('manual');
    window.addEventListener(DESKTOP_UPDATE_MANUAL_CHECK_EVENT, handleManualCheck);
    const timer = isAutomaticUpdateCheckEnabled()
      ? window.setTimeout(() => {
        // Re-read at execution time as well: turning the switch off during the
        // eight-second startup grace period must still prevent the request.
        if (isAutomaticUpdateCheckEnabled()) void checkForUpdate('startup');
      }, STARTUP_CHECK_DELAY_MS)
      : null;

    return () => {
      disposed = true;
      window.removeEventListener(DESKTOP_UPDATE_MANUAL_CHECK_EVENT, handleManualCheck);
      if (timer !== null) window.clearTimeout(timer);
      void updateRef.current?.close();
      updateRef.current = null;
    };
  }, []);

  const dismiss = useCallback(() => {
    if (installing) return;
    void update?.close();
    updateRef.current = null;
    setUpdate(null);
    setError(null);
  }, [installing, update]);

  const install = useCallback(async () => {
    if (!update || installing) return;
    setInstalling(true);
    setError(null);
    setProgress(0);
    downloadedRef.current = 0;
    totalBytesRef.current = undefined;
    try {
      await update.downloadAndInstall(event => {
        if (event.event === 'Started') {
          totalBytesRef.current = event.data.contentLength;
          setProgress(updateProgressPercent(0, event.data.contentLength));
          return;
        }
        if (event.event === 'Progress') {
          downloadedRef.current += event.data.chunkLength;
          setProgress(updateProgressPercent(downloadedRef.current, totalBytesRef.current));
          return;
        }
        if (event.event === 'Finished') setProgress(100);
      });

      // Installing can replace files while the current process is alive. Flush
      // the editor and create a recovery point immediately before relaunch.
      const save = await requestSaveNow({ createRecoveryPoint: true });
      if (!save.ok) throw new Error(t.updateSaveFailed);
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.updateInstallFailed);
      setInstalling(false);
      setProgress(null);
    }
  }, [installing, t.updateInstallFailed, t.updateSaveFailed, update]);

  if (!update) return null;

  return (
    <section
      role={critical ? 'alert' : 'status'}
      aria-live={critical ? 'assertive' : 'polite'}
      aria-label={critical ? t.updateCriticalTitle : t.updateAvailableTitle}
      className={
        critical
          ? 'fixed inset-x-4 top-10 z-[110] mx-auto max-w-xl border border-book-danger bg-book-bg-card p-4 shadow-overlay'
          : 'fixed bottom-5 left-1/2 z-[95] w-[min(92vw,34rem)] -translate-x-1/2 border border-book-gold/50 bg-book-bg-card p-3 shadow-overlay'
      }
    >
      <div className="flex items-start gap-3">
        {critical ? (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-book-danger" />
        ) : (
          <Download className="mt-0.5 h-5 w-5 shrink-0 text-book-gold" />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-book-ink-primary">
            {critical ? t.updateCriticalTitle : t.updateAvailableTitle}
          </h2>
          <p className="mt-1 text-xs text-book-ink-secondary">
            {t.updateVersion.replace('{version}', update.version)}
          </p>
          {update.body ? <p className="mt-2 line-clamp-2 text-xs text-book-ink-muted">{update.body}</p> : null}
          {installing ? (
            <p className="mt-2 text-xs text-book-ink-secondary">
              {progress === null ? t.updateInstalling : t.updateProgress.replace('{progress}', String(progress))}
            </p>
          ) : null}
          {error ? <p className="mt-2 text-xs text-book-danger">{error}</p> : null}
        </div>
        <Button
          type="button"
          size="sm"
          variant={critical ? 'destructive' : 'accent'}
          onClick={() => void install()}
          disabled={installing}
        >
          {installing ? <Spinner size="sm" /> : <Download className="h-3.5 w-3.5" />}
          {installing ? t.updateInstalling : t.updateInstall}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={dismiss}
          disabled={installing}
          className="h-7 w-7 text-book-ink-muted"
          aria-label={t.updateLater}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}
