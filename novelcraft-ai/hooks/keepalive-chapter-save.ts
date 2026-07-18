/**
 * Close-path keepalive save for the active chapter draft (window unload / tab
 * close). Extracted from {@link useChapterDraftController} so the HTTP-outcome
 * contract can be exercised directly with a mocked fetch instead of a
 * source-shape guard.
 *
 * The subtlety this guards: `fetch` RESOLVES for any HTTP response — including
 * 409 (optimistic-concurrency version conflict) and 5xx — and only REJECTS on a
 * network-level failure. Treating a resolved promise as success would clear the
 * dirty buffer on a 409/500 and silently drop the user's unsaved edits: the
 * localStorage draft-recovery layer discards a version-mismatched draft as
 * stale, so a 409 is a real data-loss path.
 *
 * Contract:
 * - 2xx  → `onSaved()` (drop the dirty buffer), then `onSettled()`.
 * - non-2xx (409 / 5xx) → keep the dirty buffer, `onSettled()` only.
 * - network reject → keep the dirty buffer, `onSettled()` only.
 *
 * `onSettled` always runs so the close-path claim is released and the debounced
 * autosave / unmount flush can retry when the buffer is still dirty.
 */
export async function performKeepaliveChapterSave(
  fetchImpl: typeof fetch,
  url: string,
  body: string,
  onSaved: () => void,
  onSettled: () => void,
): Promise<void> {
  try {
    const response = await fetchImpl(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
    if (response.ok) {
      // 2xx — the dirty buffer is now durably saved.
      onSaved();
    }
    // Non-2xx (409 version conflict / 5xx): keep the dirty buffer so the normal
    // debounced autosave / unmount flush can retry with conflict handling.
  } catch {
    // Network-level failure (drop / abort): keep the dirty buffer for retry.
  } finally {
    onSettled();
  }
}
