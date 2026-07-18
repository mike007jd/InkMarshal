'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/components/LanguageProvider';
import {
  getCapabilityProfile,
  getConnections,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';
import { clearDanglingBindings, findDanglingBindings } from '@/lib/model-supply/orchestrator';
import { CAPABILITY_ROLES } from '@/lib/model-supply/types';
import {
  listInstalledLocalModels,
  modelDirFreeBytes,
  isTauriRuntime,
} from '@/lib/desktop-runtime';
import { subscribeLocalModelStateChanged } from '@/lib/model-supply/local-model-events';
import type { InstalledLocalModel } from '@/lib/model-supply/types';

const FREE_SPACE_WARNING_BYTES = 2 * 1024 ** 3; // 2 GB

interface Issue {
  id: string;
  kind: 'no-models' | 'dangling-binding' | 'low-disk';
  title: string;
  detail: string;
  cta?: { label: string; onClick: () => void | Promise<void> };
}

export function DiagnosticsPanel({
  includeNoModels = true,
}: {
  includeNoModels?: boolean;
} = {}) {
  const { t } = useLanguage();
  const [danglingRoles, setDanglingRoles] = useState<string[]>([]);
  const [hasValidBinding, setHasValidBinding] = useState(false);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  const [installed, setInstalled] = useState<InstalledLocalModel[]>([]);
  const installedSeqRef = useRef(0);
  const freeBytesSeqRef = useRef(0);

  const refreshInstalled = useCallback(async () => {
    if (!isTauriRuntime()) {
      return;
    }
    const seq = ++installedSeqRef.current;
    const list = await listInstalledLocalModels().catch(() => [] as InstalledLocalModel[]);
    if (installedSeqRef.current !== seq) return;
    setInstalled(list);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshInstalled(), 0);
    const unsubscribe = subscribeLocalModelStateChanged(() => {
      void refreshInstalled();
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refreshInstalled]);

  useEffect(() => {
    const recompute = () => {
      const knownIds = new Set(getConnections().map(c => c.id));
      setDanglingRoles(findDanglingBindings(knownIds));
      const profile = getCapabilityProfile();
      setHasValidBinding(
        CAPABILITY_ROLES.some(role => {
          const binding = profile[role];
          return binding != null && knownIds.has(binding.connectionId);
        }),
      );
    };
    recompute();
    return subscribeConnectionsStore(recompute);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const seq = ++freeBytesSeqRef.current;
    let cancelled = false;
    modelDirFreeBytes()
      .then(value => {
        if (!cancelled && freeBytesSeqRef.current === seq) setFreeBytes(value);
      })
      .catch(() => {
        if (!cancelled && freeBytesSeqRef.current === seq) setFreeBytes(null);
      });
    return () => {
      cancelled = true;
    };
  }, [installed.length]);

  const issues = useMemo<Issue[]>(() => {
    const out: Issue[] = [];
    if (includeNoModels && installed.length === 0 && !hasValidBinding) {
      out.push({
        id: 'no-models',
        kind: 'no-models',
        title: t.diagnosticsNoModelsTitle,
        detail: t.diagnosticsNoModelsDetail,
      });
    }
    if (danglingRoles.length > 0) {
      out.push({
        id: 'dangling-binding',
        kind: 'dangling-binding',
        title: t.diagnosticsDanglingTitle.replace('{count}', String(danglingRoles.length)),
        detail: t.diagnosticsDanglingDetail.replace('{roles}', danglingRoles.join(', ')),
        cta: {
          label: t.diagnosticsDanglingFix,
          onClick: () => {
            const knownIds = new Set(getConnections().map(c => c.id));
            clearDanglingBindings(knownIds);
          },
        },
      });
    }
    if (freeBytes !== null && freeBytes < FREE_SPACE_WARNING_BYTES) {
      const gb = (freeBytes / 1024 ** 3).toFixed(1);
      out.push({
        id: 'low-disk',
        kind: 'low-disk',
        title: t.diagnosticsLowDiskTitle,
        detail: t.diagnosticsLowDiskDetail.replace('{free}', gb),
      });
    }
    return out;
  }, [includeNoModels, installed.length, hasValidBinding, danglingRoles, freeBytes, t]);

  if (issues.length === 0) return null;

  return (
    <section className="rounded-md border border-book-border bg-book-bg-secondary/40 p-3 text-sm">
      <header className="mb-2 flex items-center gap-2 font-semibold text-book-ink-primary">
        <AlertTriangle className="h-3.5 w-3.5 text-book-warning" aria-hidden="true" />
        <span>{t.diagnosticsTitle}</span>
      </header>
      <ul className="space-y-2">
        {issues.map(issue => (
          <li key={issue.id} className="flex flex-col gap-1 text-book-ink-secondary">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <strong>{issue.title}</strong>
              {issue.cta && (
                <Button
                  variant="accent"
                  type="button"
                  onClick={() => void issue.cta!.onClick()}
                  className="h-auto px-3 py-1 text-xs font-semibold"
                >
                  {issue.cta.label}
                </Button>
              )}
            </div>
            <p className="text-xs">{issue.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
