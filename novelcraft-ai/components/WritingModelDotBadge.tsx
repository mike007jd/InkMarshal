'use client';

import { useMemo, useSyncExternalStore } from 'react';

import { WritingModelStatusBar } from '@/components/WritingModelStatusBar';
import { useConnectionHealth } from '@/components/writing-model-health';
import {
  OPERATION_ROLE,
  type CapabilityBinding,
  type OperationKind,
  type RuntimeConnection,
} from '@/lib/model-supply/types';
import {
  getBindingForRole,
  getConnection,
  subscribeConnectionsStore,
} from '@/lib/model-supply/connections';

const SERVER_SNAPSHOT = ' ssr';

/**
 * Read the current binding via `useSyncExternalStore` so the notice
 * re-renders whenever the user changes a binding from Settings / ModelsPanel.
 * Single hook call site keeps the call order stable.
 */
function useBindingSnapshot(operation: OperationKind): {
  mounted: boolean;
  binding: CapabilityBinding | null;
  conn: RuntimeConnection | undefined;
} {
  const role = OPERATION_ROLE[operation];
  const snapshot = useSyncExternalStore(
    subscribeConnectionsStore,
    () => {
      const binding = getBindingForRole(role);
      const conn = binding ? getConnection(binding.connectionId) : undefined;
      return JSON.stringify({ b: binding ?? null, c: conn ?? null });
    },
    () => SERVER_SNAPSHOT,
  );
  return useMemo(() => {
    if (snapshot === SERVER_SNAPSHOT) {
      return { mounted: false, binding: null, conn: undefined };
    }
    const parsed = JSON.parse(snapshot) as {
      b: CapabilityBinding | null;
      c: RuntimeConnection | null;
    };
    return {
      mounted: true,
      binding: parsed.b,
      conn: parsed.c ?? undefined,
    };
  }, [snapshot]);
}

/**
 * Quiet health notice for manuscript work. A healthy model needs no chrome;
 * only an unbound or degraded model renders the actionable status strip.
 */
export function WritingModelDotBadge({
  operation,
  unboundDensity = 'strip',
}: {
  operation: OperationKind;
  unboundDensity?: 'strip' | 'compact';
}) {
  const { mounted, binding, conn } = useBindingSnapshot(operation);
  const bound = Boolean(binding && conn);
  const { health } = useConnectionHealth(conn);

  // Only actionable states occupy layout. The initial probe and healthy state
  // stay silent, while an unbound or failed model keeps its repair CTA.
  if (mounted && (!bound || health === 'down')) {
    return <WritingModelStatusBar operation={operation} density={unboundDensity} />;
  }

  return null;
}
