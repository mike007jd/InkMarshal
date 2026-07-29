/**
 * Per-novel serialization for Vault root bind/clear versus Markdown mirror I/O.
 * Entry-level outbox write locks remain separate and must stay in place.
 */

const novelRootOpTails = new Map<string, Promise<unknown>>();

export async function withNovelVaultRootLock<T>(
  novelId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = novelRootOpTails.get(novelId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const next = previous.then(() => gate, () => gate);
  novelRootOpTails.set(novelId, next);
  await previous.then(() => undefined, () => undefined);
  try {
    return await task();
  } finally {
    release();
    if (novelRootOpTails.get(novelId) === next) {
      novelRootOpTails.delete(novelId);
    }
  }
}
