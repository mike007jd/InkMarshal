'use client';

import { engineStatus } from '@/lib/desktop-runtime';
import { hasLiveWritingConnection } from '@/lib/model-supply/readiness';
import { OPERATION_ROLE, type CapabilityRole, type OperationKind } from '@/lib/model-supply/types';

export const AI_ACTION_GATE_EVENT = 'inkmarshal:ai-action-gate';
export const MODELS_PANEL_CLOSED_EVENT = 'inkmarshal:models-panel-closed';

export class AIActionGateCancelledError extends Error {
  constructor(public readonly reason: 'cancelled' | 'scope-changed' | 'superseded' | 'unavailable') {
    super('AI action cancelled');
    this.name = 'AIActionGateCancelledError';
  }
}

export function isAIActionGateCancellation(error: unknown): error is AIActionGateCancelledError {
  return error instanceof AIActionGateCancelledError;
}

export type AIActionOperations = OperationKind | readonly OperationKind[];

export interface AIActionGateRequest {
  id: string;
  operations: readonly OperationKind[];
  scopePath: string;
  handled: boolean;
  resolve(): void;
  reject(reason: AIActionGateCancelledError['reason']): void;
}

function normalizeOperations(operations: AIActionOperations): readonly OperationKind[] {
  return Array.isArray(operations) ? operations : [operations as OperationKind];
}

export function rolesForAIAction(operations: AIActionOperations): readonly CapabilityRole[] {
  return [...new Set(normalizeOperations(operations).map(operation => OPERATION_ROLE[operation]))];
}

export async function isAIActionReady(operations: AIActionOperations): Promise<boolean> {
  const engines = await engineStatus().catch(() => []);
  return rolesForAIAction(operations)
    .every(role => hasLiveWritingConnection(engines, [role]));
}

export async function awaitAIActionReady(
  operations: AIActionOperations,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new AIActionGateCancelledError('scope-changed');
  if (await isAIActionReady(operations)) return;
  if (typeof window === 'undefined') throw new AIActionGateCancelledError('unavailable');

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = () => finish(() => reject(new AIActionGateCancelledError('scope-changed')));
    const request: AIActionGateRequest = {
      id: crypto.randomUUID(),
      operations: normalizeOperations(operations),
      scopePath: window.location.pathname,
      handled: false,
      resolve: () => finish(resolve),
      reject: reason => finish(() => reject(new AIActionGateCancelledError(reason))),
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    window.dispatchEvent(new CustomEvent<AIActionGateRequest>(AI_ACTION_GATE_EVENT, { detail: request }));
    if (!request.handled) request.reject('unavailable');
  });
}
