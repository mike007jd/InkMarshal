export interface UpdateMetadataLike {
  rawJson?: Record<string, unknown>;
}

/** Release automation may mark a release as critical in latest.json. Keep the
 * parser deliberately strict: only a literal boolean true escalates the UI. */
export function isCriticalDesktopUpdate(update: UpdateMetadataLike): boolean {
  return update.rawJson?.critical === true;
}

export function updateProgressPercent(downloaded: number, total?: number): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)));
}
