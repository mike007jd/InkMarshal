'use client';

import { useEffect, useRef } from 'react';
import { useParams, usePathname } from 'next/navigation';

import { isTauriRuntime } from '@/lib/desktop-runtime';
import {
  createVaultRuntimeCoordinator,
  novelIdFromStudioRoute,
} from '@/lib/vault/runtime-coordinator';

/**
 * Mounted once from DesktopShell. Owns the production Vault watcher lifecycle
 * and durable outbox drain for the active novel (plus a startup global drain).
 */
export function VaultRuntimeCoordinator() {
  const params = useParams();
  const pathname = usePathname();
  const activeNovelId = novelIdFromStudioRoute(pathname, params);
  const activeNovelIdRef = useRef<string | null>(null);
  const coordinatorRef = useRef<ReturnType<typeof createVaultRuntimeCoordinator> | null>(null);

  useEffect(() => {
    activeNovelIdRef.current = activeNovelId;
  }, [activeNovelId]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const coordinator = createVaultRuntimeCoordinator({
      getActiveNovelId: () => activeNovelIdRef.current,
    });
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void coordinator.start().then(stop => {
      if (disposed) stop();
      else {
        cleanup = stop;
        // Expose sync only after the Tauri event listener is registered.
        // start() performs the initial sync against the latest ref value.
        coordinatorRef.current = coordinator;
      }
    }).catch(error => {
      console.warn('[vault/runtime] coordinator start failed', error);
    });
    return () => {
      disposed = true;
      cleanup?.();
      coordinatorRef.current = null;
    };
  }, []);

  useEffect(() => {
    void coordinatorRef.current?.syncActiveNovel()?.catch(error => {
      console.warn('[vault/runtime] syncActiveNovel failed', error);
    });
  }, [activeNovelId]);

  return null;
}
