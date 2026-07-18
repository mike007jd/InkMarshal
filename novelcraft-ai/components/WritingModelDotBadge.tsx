'use client';

import { useMemo, useSyncExternalStore } from 'react';

import { openModelsPanel } from '@/components/ModelsPanel';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useLanguage } from '@/components/LanguageProvider';
import { WritingModelStatusBar } from '@/components/WritingModelStatusBar';
import { useConnectionHealth } from '@/components/writing-model-health';
import {
  CAPABILITY_ROLES,
  OPERATION_ROLE,
  type CapabilityBinding,
  type CapabilityRole,
  type OperationKind,
  type RuntimeConnection,
} from '@/lib/model-supply/types';
import {
  getBindingForRole,
  getCapabilityProfile,
  getConnection,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';

const SERVER_SNAPSHOT = ' ssr';

interface RoleBindingsRow {
  modelId: string;
  connectionId: string;
  connectionLabel: string;
}

/**
 * Read the binding + role-snapshot via `useSyncExternalStore` so the dot
 * re-renders whenever the user changes a binding from Settings / ModelsPanel.
 * Single hook call site keeps the call order stable.
 */
function useBindingSnapshot(operation: OperationKind): {
  mounted: boolean;
  binding: CapabilityBinding | null;
  conn: RuntimeConnection | undefined;
  roleBindings: Map<CapabilityRole, RoleBindingsRow>;
} {
  const role = OPERATION_ROLE[operation];
  const snapshot = useSyncExternalStore(
    subscribeConnectionsStore,
    () => {
      const binding = getBindingForRole(role);
      const conn = binding ? getConnection(binding.connectionId) : undefined;
      const profile = getCapabilityProfile();
      const roles: Record<CapabilityRole, RoleBindingsRow | null> = {
        draft: null,
        rewrite: null,
        planning: null,
        recall: null,
      };
      for (const r of CAPABILITY_ROLES) {
        const b = profile[r];
        if (!b) continue;
        const c = getConnection(b.connectionId);
        if (!c) continue;
        roles[r] = { modelId: b.modelId, connectionId: b.connectionId, connectionLabel: c.label };
      }
      return JSON.stringify({ b: binding ?? null, c: conn ?? null, r: roles });
    },
    () => SERVER_SNAPSHOT,
  );
  return useMemo(() => {
    if (snapshot === SERVER_SNAPSHOT) {
      return { mounted: false, binding: null, conn: undefined, roleBindings: new Map() };
    }
    const parsed = JSON.parse(snapshot) as {
      b: CapabilityBinding | null;
      c: RuntimeConnection | null;
      r: Record<CapabilityRole, RoleBindingsRow | null>;
    };
    const rb = new Map<CapabilityRole, RoleBindingsRow>();
    for (const role of CAPABILITY_ROLES) {
      const v = parsed.r[role];
      if (v) rb.set(role, v);
    }
    return {
      mounted: true,
      binding: parsed.b,
      conn: parsed.c ?? undefined,
      roleBindings: rb,
    };
  }, [snapshot]);
}

function hasMultipleEngines(map: Map<CapabilityRole, RoleBindingsRow>): boolean {
  const seen = new Set<string>();
  for (const { connectionId } of map.values()) {
    seen.add(connectionId);
    if (seen.size >= 2) return true;
  }
  return false;
}

function roleShortLabel(
  role: CapabilityRole,
  t: ReturnType<typeof useLanguage>['t'],
): string {
  switch (role) {
    case 'draft':
      return t.capabilityRoleDraftLabel;
    case 'rewrite':
      return t.capabilityRoleRewriteLabel;
    case 'planning':
      return t.capabilityRolePlanningLabel;
    case 'recall':
      return t.capabilityRoleRecallLabel;
  }
}

/**
 * Dot-badge replacement for the full WritingModelStatusBar strip (W4 macOS
 * native shell, plan §4.3). Healthy state collapses to a single 6px dot in
 * the top-right; hover surfaces the same tooltip the strip had. Anything
 * other than "ok" falls back to the full strip so the user always sees the
 * failure CTA.
 */
export function WritingModelDotBadge({
  operation,
  unboundDensity = 'strip',
}: {
  operation: OperationKind;
  unboundDensity?: 'strip' | 'compact';
}) {
  const { t } = useLanguage();
  const { mounted, binding, conn, roleBindings } = useBindingSnapshot(operation);
  const bound = Boolean(binding && conn);
  const { health, latencyMs } = useConnectionHealth(conn);

  // Pre-mount or unbound / down: fall back to the full strip so the user has
  // the repair CTA visible without hunting for it.
  if (!mounted || !bound || health !== 'ok') {
    return <WritingModelStatusBar operation={operation} density={unboundDensity} />;
  }

  const showRoleBindings = hasMultipleEngines(roleBindings);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="unstyled"
            size="unstyled"
            type="button"
            onClick={() => openModelsPanel()}
            aria-label={t.statusBarHealthOk}
            data-shape="model-health-dot"
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-book-success transition-transform hover:scale-110"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-book-success" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-0.5 text-xs-tight">
            <div className="font-medium text-book-ink-secondary">
              {conn!.label} · {binding!.modelId}
            </div>
            <div className="text-book-ink-muted">
              {conn!.baseUrl}
              {latencyMs != null ? ` · ${latencyMs} ms` : ''}
            </div>
            {showRoleBindings && (
              <div className="mt-1.5 border-t border-book-border pt-1.5">
                <div className="mb-0.5 font-medium text-book-ink-secondary">
                  {t.writingModelStatusBindingsTooltip}
                </div>
                <ul className="space-y-0.5">
                  {Array.from(roleBindings.entries()).map(([role, info]) => (
                    <li key={role} className="truncate">
                      {roleShortLabel(role, t)}: {info.modelId}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
