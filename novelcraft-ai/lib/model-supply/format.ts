// Shared model-supply formatting helpers. Kept dependency-free so both server
// resolvers and client panels can import it.

/**
 * Human-readable byte size (B/KB/MB/GB/TB), 1024-based, one decimal except
 * whole bytes. Returns `'0 B'` for null / undefined / non-finite / ≤ 0 so every
 * call site renders a stable placeholder instead of `NaN`/`Infinity`.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
