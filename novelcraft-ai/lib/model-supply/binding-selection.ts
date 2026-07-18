import type { CapabilityBinding } from './types';

export function bindingForConnectionSelection(
  connectionId: string,
  modelOptions: readonly string[],
  currentBinding: CapabilityBinding | null | undefined,
): CapabilityBinding | null {
  const nextConnectionId = connectionId.trim();
  const modelId = modelOptions.map(option => option.trim()).find(Boolean);
  if (!nextConnectionId || !modelId) return null;

  const next: CapabilityBinding = {
    connectionId: nextConnectionId,
    modelId,
  };
  if (
    currentBinding?.fallback &&
    currentBinding.fallback.connectionId !== nextConnectionId
  ) {
    next.fallback = currentBinding.fallback;
  }
  return next;
}
