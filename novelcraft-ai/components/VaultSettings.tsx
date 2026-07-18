'use client';

// Wave 2 commit B — "Knowledge Vault" section of SettingsPanel.
//
// Shows the vault path for the currently-open novel, lets the user reveal it
// in Finder, change the path, and surfaces a red banner when the vault is
// unreachable (e.g. Seafile is offline).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { AlertTriangle, FolderOpen, FolderSync, HardDrive } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { isTauriRuntime } from '@/lib/desktop-runtime';
import {
  vaultInit,
  vaultReachable,
  vaultRevealInFinder,
  defaultVaultPathForNovel,
} from '@/lib/vault';
import {
  getNovelVaultStatus,
  setNovelVaultPathAction,
  type NovelVaultStatus,
} from '@/app/actions/vault';
import { reconcileVaultSnapshot } from '@/lib/vault/snapshot-reconcile';

interface VaultSettingsProps {
  /** Optional novelId override; falls back to the URL params. */
  novelId?: string;
}

export function VaultSettings({ novelId: novelIdProp }: VaultSettingsProps) {
  const { t } = useLanguage();
  const params = useParams();
  const novelId = novelIdProp ?? (typeof params?.id === 'string' ? params.id : null);

  const [status, setStatus] = useState<NovelVaultStatus | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeNovelRef = useRef<string | null>(novelId);

  useEffect(() => {
    let cancelled = false;
    activeNovelRef.current = novelId;
    queueMicrotask(() => {
      if (cancelled) return;
      setStatus(null);
      setReachable(null);
      setBusy(false);
      setError(null);
    });
    return () => {
      cancelled = true;
    };
  }, [novelId]);

  const refresh = useCallback(async () => {
    const requestNovelId = novelId;
    if (!novelId) {
      setStatus(null);
      setReachable(null);
      return;
    }
    setError(null);
    try {
      const s = await getNovelVaultStatus(novelId);
      if (activeNovelRef.current !== requestNovelId) return;
      setStatus(s);
      if (s.vaultPath && isTauriRuntime()) {
        const r = await vaultReachable(s.vaultPath);
        if (activeNovelRef.current !== requestNovelId) return;
        setReachable(r.reachable && r.writable);
      } else {
        setReachable(null);
      }
    } catch (err) {
      if (activeNovelRef.current === requestNovelId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [novelId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // First-time provisioning: if the novel has no vault_path yet, allocate the
  // default location lazily and persist it. We only do this inside Tauri
  // because the Rust commands aren't reachable from the Web build.
  useEffect(() => {
    if (!novelId || !status) return;
    if (status.vaultPath || !isTauriRuntime()) return;
    let cancelled = false;
    const requestNovelId = novelId;
    (async () => {
      try {
        const def = await defaultVaultPathForNovel(novelId);
        if (!def || cancelled || activeNovelRef.current !== requestNovelId) return;
        await vaultInit(novelId, def);
        await setNovelVaultPathAction(novelId, def);
        if (!cancelled && activeNovelRef.current === requestNovelId) await refresh();
      } catch (err) {
        if (!cancelled && activeNovelRef.current === requestNovelId) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [novelId, status, refresh]);

  const onReveal = async () => {
    if (!novelId || !status?.vaultPath) return;
    const requestNovelId = novelId;
    try {
      await vaultRevealInFinder(novelId, status.vaultPath);
    } catch (err) {
      if (activeNovelRef.current === requestNovelId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const onChange = async () => {
    if (!novelId) return;
    const requestNovelId = novelId;
    setBusy(true);
    setError(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: false, directory: true });
      if (typeof picked !== 'string') {
        if (activeNovelRef.current === requestNovelId) setBusy(false);
        return;
      }
      await vaultInit(novelId, picked);
      await reconcileVaultSnapshot(novelId, picked, { failOnReconcileError: true });
      await setNovelVaultPathAction(novelId, picked);
      if (activeNovelRef.current === requestNovelId) await refresh();
    } catch (err) {
      if (activeNovelRef.current === requestNovelId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (activeNovelRef.current === requestNovelId) setBusy(false);
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <HardDrive className="h-3.5 w-3.5 text-book-ink-muted" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-book-ink-muted">
          {t.settingsVault}
        </h3>
      </div>

      <p className="mb-3 text-xs text-book-ink-muted">{t.vaultSectionDescription}</p>

      {!novelId ? (
        <p className="text-sm text-book-ink-muted">{t.vaultPathOpenNovelHint}</p>
      ) : (
        <>
          <label className="mb-2 block text-xs text-book-ink-muted">{t.vaultPathLabel}</label>
          <div className="mb-2 break-all rounded border border-book-border bg-book-bg-secondary px-3 py-2 text-xs font-mono text-book-ink-primary">
            {status?.vaultPath ?? t.vaultPathNotSet}
          </div>

          {reachable === false && status?.vaultPath && (
            <div className="mb-3 flex items-start gap-2 rounded border border-book-warning-border bg-book-warning-light px-3 py-2 text-xs text-book-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t.vaultPathUnreachable}</span>
            </div>
          )}

          {error && (
            <div className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReveal}
              disabled={!status?.vaultPath || !isTauriRuntime()}
            >
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              {t.vaultPathRevealInFinder}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onChange}
              disabled={busy || !isTauriRuntime()}
            >
              <FolderSync className="mr-1.5 h-3.5 w-3.5" />
              {t.vaultPathChange}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
