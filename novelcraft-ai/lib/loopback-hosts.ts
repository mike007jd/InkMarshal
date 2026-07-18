// Single source of truth for "is this host the local machine?".
//
// This guards secret transport: a plaintext `http://` runtime may still carry
// an API key (or run keyless) ONLY when its host is loopback. Seven copies of
// this Set used to live across ai-providers / user-runtime-origin / model-supply
// / knowledge — drift here would silently widen where a key may be sent in the
// clear, so it lives in exactly one place now.
//
// Mirrors the loopback host handling in the Rust layer (`src-tauri`).
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

/** True when `hostname` resolves to the local machine. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/**
 * True for an `http://` URL whose host is loopback — the only plaintext case
 * where carrying an API key (or keyless local access) is acceptable.
 */
export function isLoopbackHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}
