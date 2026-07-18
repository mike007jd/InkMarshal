'use client';

import { useMemo, useSyncExternalStore } from 'react';
import { Settings2 } from 'lucide-react';
import { useLanguage } from '@/components/LanguageProvider';
import { openModelsPanel } from '@/components/ModelsPanel';
import { useConnectionHealth } from '@/components/writing-model-health';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  getBindingForRole,
  getCapabilityProfile,
  getConnection,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';
import {
  CAPABILITY_ROLES,
  OPERATION_ROLE,
  type CapabilityBinding,
  type CapabilityRole,
  type OperationKind,
  type RuntimeConnection,
} from '@/lib/model-supply/types';
import { isOnDeviceRuntimeConnection } from '@/lib/model-supply/readiness';

export interface ResolvedBinding {
  binding: CapabilityBinding | null;
  conn: RuntimeConnection | undefined;
}

// SSR-safe reactive read of the capability binding for an operation, via
// useSyncExternalStore.
//
// The store is localStorage-backed, so reading it in the render body would (a)
// render the "unbound" branch on the server and the "bound" branch on the
// client → a React 19 hydration mismatch for every configured user, and (b)
// never re-render when a sibling subtree (Settings) mutates the binding.
//
// `getServerSnapshot` returns a constant sentinel so the server + first client
// render are identical (neutral placeholder) — no hydration mismatch. After
// hydration React swaps to the client snapshot. The snapshot is a *serialized
// string* (a stable primitive) so useSyncExternalStore's Object.is check does
// not loop on the store's fresh object identities; the real objects are
// re-resolved from the live store only when that string changes.
const SERVER_SNAPSHOT = ' ssr';

export function useCapabilityBinding(operation: OperationKind): {
  mounted: boolean;
  resolved: ResolvedBinding;
} {
  const role = OPERATION_ROLE[operation];

  const snapshot = useSyncExternalStore(
    subscribeConnectionsStore,
    () => {
      const binding = getBindingForRole(role);
      const conn = binding ? getConnection(binding.connectionId) : undefined;
      // RuntimeConnection is a flat JSON-serializable record, so the full
      // object round-trips — the health probe still gets transport/baseUrl/id.
      // The string is stable across re-reads when nothing changed, so
      // useSyncExternalStore's Object.is check does not loop.
      return JSON.stringify({ b: binding ?? null, c: conn ?? null });
    },
    () => SERVER_SNAPSHOT,
  );

  return useMemo(() => {
    const mounted = snapshot !== SERVER_SNAPSHOT;
    if (!mounted) {
      return { mounted, resolved: { binding: null, conn: undefined } };
    }
    const parsed = JSON.parse(snapshot) as {
      b: CapabilityBinding | null;
      c: RuntimeConnection | null;
    };
    return {
      mounted,
      resolved: { binding: parsed.b, conn: parsed.c ?? undefined },
    };
  }, [snapshot]);
}

interface RoleBindingsRow {
  modelId: string;
  connectionId: string;
  connectionLabel: string;
}

/**
 * Wave 4 commit C: snapshot of all 4 role bindings so the writing-strip
 * tooltip can show "Drafting on X · Polish on Y" when more than one engine is
 * live. Reads through the same subscribe-store so a mutation in Settings or
 * CapabilityBindingPanel re-renders this tooltip immediately. The snapshot is
 * a serialized string for stable Object.is equality.
 */
function useRoleBindingsSnapshot(): Map<CapabilityRole, RoleBindingsRow> {
  const ROLE_SNAPSHOT_SSR = '__role-ssr__';
  const snapshot = useSyncExternalStore(
    subscribeConnectionsStore,
    () => {
      const profile = getCapabilityProfile();
      const out: Record<CapabilityRole, RoleBindingsRow | null> = {
        draft: null,
        rewrite: null,
        planning: null,
        recall: null,
      };
      for (const role of CAPABILITY_ROLES) {
        const binding = profile[role];
        if (!binding) continue;
        const conn = getConnection(binding.connectionId);
        if (!conn) continue;
        out[role] = {
          modelId: binding.modelId,
          connectionId: binding.connectionId,
          connectionLabel: conn.label,
        };
      }
      return JSON.stringify(out);
    },
    () => ROLE_SNAPSHOT_SSR,
  );
  return useMemo(() => {
    const map = new Map<CapabilityRole, RoleBindingsRow>();
    if (snapshot === ROLE_SNAPSHOT_SSR) return map;
    try {
      const parsed = JSON.parse(snapshot) as Record<
        CapabilityRole,
        RoleBindingsRow | null
      >;
      for (const role of CAPABILITY_ROLES) {
        const v = parsed[role];
        if (v) map.set(role, v);
      }
    } catch {
      // Parse failures collapse to "no extra info" — the basic single-op
      // tooltip still renders.
    }
    return map;
  }, [snapshot]);
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
 * True when at least two role bindings point at different connections — i.e.
 * multi-engine (or mixed local + provider) is actually in play. A single-
 * engine setup doesn't need the extra tooltip noise.
 */
function hasMultipleEngines(bindings: Map<CapabilityRole, RoleBindingsRow>): boolean {
  const seenConns = new Set<string>();
  for (const { connectionId } of bindings.values()) {
    seenConns.add(connectionId);
    if (seenConns.size >= 2) return true;
  }
  return false;
}

function operationLabel(
  op: OperationKind,
  t: ReturnType<typeof useLanguage>['t'],
): string {
  switch (op) {
    case 'outline':
      return t.statusBarOperationOutline;
    case 'chat':
      return t.statusBarOperationChat;
    case 'polish':
      return t.statusBarOperationPolish;
    case 'chapter':
      return t.statusBarOperationChapter;
    case 'unify':
      return t.statusBarOperationUnify;
    default:
      return op;
  }
}

// Compact, READ-ONLY status strip for the writing surface. It surfaces which
// model serves the panel's operation and a non-blocking CTA into Settings when
// nothing is bound. It deliberately has NO model picker — configuration lives
// in Settings only (spec Non-Goal: the writer writes, they don't pick models
// mid-flow).
export function WritingModelStatusBar({
  operation,
  density = 'strip',
}: {
  operation: OperationKind;
  density?: 'strip' | 'compact';
}) {
  const { t } = useLanguage();
  const { mounted, resolved } = useCapabilityBinding(operation);
  // useSyncExternalStore hook MUST run every render before the early returns
  // below — moving this past the bound/unmounted branches would violate the
  // rules of hooks.
  const roleBindings = useRoleBindingsSnapshot();
  const { binding, conn } = resolved;
  const bound = Boolean(binding && conn);
  const { health } = useConnectionHealth(conn);

  // Server + first client render: a quiet, content-neutral placeholder (NOT the
  // red unbound CTA) so the markup is identical on both sides — no hydration
  // mismatch. The real bound/unbound state shows after mount.
  if (!mounted) {
    if (density === 'compact') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-md border border-book-border bg-book-bg-card/70 px-2.5 py-1 text-xs-tight text-book-ink-muted" aria-hidden>
          <span className="h-1.5 w-1.5 rounded-full bg-book-ink-muted" />
          {operationLabel(operation, t)}
        </span>
      );
    }
    return (
      <div
        className="flex w-full items-center gap-2 border-b border-book-border bg-book-bg-secondary/40 px-3 py-1.5 text-xs-tight text-book-ink-muted"
        aria-hidden
      >
        <span className="font-medium text-book-ink-secondary">
          {operationLabel(operation, t)}
        </span>
        <span className="text-book-ink-muted">·</span>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-book-ink-muted" />
        <span className="text-book-ink-muted">{t.statusBarHealthChecking}</span>
      </div>
    );
  }

  if (!bound) {
    if (density === 'compact') {
      return (
        <Button
          variant="unstyled"
          size="unstyled"
          type="button"
          onClick={() => openModelsPanel('providers')}
          className="inline-flex cursor-pointer items-center gap-1.5 border border-book-gold/40 bg-book-gold/5 px-2.5 py-1 text-xs-tight font-medium text-book-ink-secondary transition hover:bg-book-gold/10"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-book-gold" aria-hidden />
          {t.statusBarUnbound.replace('{op}', operationLabel(operation, t))}
          <Settings2 className="h-3 w-3" />
        </Button>
      );
    }
    return (
      <div className="flex w-full items-center gap-2 border-b border-book-border bg-book-bg-secondary/40 px-3 py-1.5 text-xs-tight">
        <Badge variant="muted">
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-book-gold" />
          {t.statusBarUnbound.replace('{op}', operationLabel(operation, t))}
        </Badge>
        <Button
          variant="unstyled"
          size="unstyled"
          type="button"
          onClick={() => openModelsPanel('providers')}
          className="inline-flex items-center gap-1 font-medium text-book-gold-dark hover:underline"
        >
          <Settings2 className="h-3 w-3" />
          {t.statusBarRepairModel}
        </Button>
      </div>
    );
  }

  const isLocal = isOnDeviceRuntimeConnection(conn!);
  const dotClass =
    health === 'ok'
      ? 'bg-book-success'
      : health === 'down'
        ? 'bg-book-danger'
        : 'bg-book-ink-muted';
  const healthText =
    health === 'ok'
      ? t.statusBarHealthOk
      : health === 'down'
        ? t.statusBarHealthDown
        : t.statusBarHealthChecking;
  // Wave 4 commit C: multi-engine tooltip row. Only render when more than one
  // role points at a different connection — single-engine setups (or 0/1 bound
  // roles) don't add useful info. The dot-badge collapsed mode (wave 3 macOS
  // native shell) inherits this same tooltip content automatically.
  const showRoleBindings = hasMultipleEngines(roleBindings);

  if (density === 'compact') {
    // Bound + compact is still a control: it opens the model settings. It rides
    // the canonical Button geometry and carries the same Settings2 affordance as
    // the unbound CTA so it never reads as a passive status badge.
    return (
      <Button
        variant="unstyled"
        size="unstyled"
        type="button"
        onClick={() => openModelsPanel('providers')}
        title={t.statusBarRepairModel}
        className="inline-flex cursor-pointer items-center gap-1.5 border border-book-border bg-book-bg-card/70 px-2.5 py-1 text-xs-tight text-book-ink-secondary transition hover:border-book-gold hover:bg-book-bg-card hover:text-book-ink-primary"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
        {operationLabel(operation, t)} · {healthText}
        <Settings2 className="h-3 w-3" />
      </Button>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex w-full items-center gap-2 border-b border-book-border bg-book-bg-secondary/40 px-3 py-1.5 text-xs-tight text-book-ink-muted">
        <span className="font-medium text-book-ink-secondary">
          {operationLabel(operation, t)}
        </span>
        <span className="text-book-ink-muted">·</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center gap-1.5">
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`}
                aria-hidden
              />
              <span className="max-w-[14rem] truncate text-book-ink-secondary">
                {isLocal
                  ? `${t.statusLocalPrefix} · ${binding!.modelId}`
                  : `${conn!.label} · ${binding!.modelId}`}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div>
              {conn!.label} · {t.statusBarVia} {conn!.baseUrl} · {healthText}
            </div>
            {showRoleBindings && (
              <div className="mt-1.5 border-t border-book-border pt-1.5 text-xs-tight text-book-ink-muted">
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
          </TooltipContent>
        </Tooltip>
        <Badge variant={isLocal ? 'success' : 'info'}>
          {isLocal ? t.statusBarTagLocal : t.statusBarTagByok}
        </Badge>
        {health === 'down' && (
          <Button
            variant="unstyled"
            size="unstyled"
            type="button"
            onClick={() => openModelsPanel('providers')}
            className="ml-auto inline-flex items-center gap-1 font-medium text-book-gold-dark hover:underline"
          >
            <Settings2 className="h-3 w-3" />
            {t.statusBarRepairModel}
          </Button>
        )}
      </div>
    </TooltipProvider>
  );
}
