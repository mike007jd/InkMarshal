'use client';

/** Fired after a live vault reconcile or outbox drain may have changed Story Deck rows. */
const VAULT_ENTRIES_CHANGED_EVENT = 'inkmarshal:vault-entries-changed';

/** Internal request channel for a provisioned or changed novel Vault path. */
const VAULT_PATH_CHANGED_EVENT = 'inkmarshal:vault-path-changed';

interface VaultEntriesChangedDetail {
  novelId: string;
}

export interface VaultPathChangedDetail {
  novelId: string;
  vaultPath: string;
}

interface VaultPathChangeAcknowledgement {
  handled: boolean;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface VaultPathChangedInternalDetail extends VaultPathChangedDetail {
  acknowledgement?: VaultPathChangeAcknowledgement;
}

export function publishVaultEntriesChanged(novelId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<VaultEntriesChangedDetail>(VAULT_ENTRIES_CHANGED_EVENT, {
      detail: { novelId },
    }),
  );
}

export function subscribeVaultEntriesChanged(
  novelId: string,
  onChange: () => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<VaultEntriesChangedDetail>).detail;
    if (detail?.novelId === novelId) onChange();
  };
  window.addEventListener(VAULT_ENTRIES_CHANGED_EVENT, handler);
  return () => window.removeEventListener(VAULT_ENTRIES_CHANGED_EVENT, handler);
}

/**
 * Ask the mounted runtime coordinator to replace the watcher and finish its
 * initial snapshot. Settings keeps its busy/error state until this settles,
 * so path changes have one serialized owner instead of racing a second direct
 * snapshot from the component.
 */
export function requestVaultPathChanged(novelId: string, vaultPath: string): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Vault runtime coordinator is unavailable'));
  }
  return new Promise<void>((resolve, reject) => {
    const acknowledgement: VaultPathChangeAcknowledgement = {
      handled: false,
      resolve,
      reject,
    };
    window.dispatchEvent(
      new CustomEvent<VaultPathChangedInternalDetail>(VAULT_PATH_CHANGED_EVENT, {
        detail: { novelId, vaultPath, acknowledgement },
      }),
    );
    queueMicrotask(() => {
      if (!acknowledgement.handled) {
        reject(new Error('Vault runtime coordinator is unavailable'));
      }
    });
  });
}

export function subscribeVaultPathChanged(
  onChange: (detail: VaultPathChangedDetail) => void | Promise<void>,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<VaultPathChangedInternalDetail>).detail;
    if (!detail?.novelId || !detail.vaultPath) return;
    const publicDetail = { novelId: detail.novelId, vaultPath: detail.vaultPath };
    const acknowledgement = detail.acknowledgement;
    if (!acknowledgement || acknowledgement.handled) return;
    acknowledgement.handled = true;
    void Promise.resolve()
      .then(() => onChange(publicDetail))
      .then(acknowledgement.resolve, acknowledgement.reject);
  };
  window.addEventListener(VAULT_PATH_CHANGED_EVENT, handler);
  return () => window.removeEventListener(VAULT_PATH_CHANGED_EVENT, handler);
}
