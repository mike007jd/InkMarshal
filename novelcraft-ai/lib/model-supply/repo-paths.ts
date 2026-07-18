export function safeRepoToDir(repoId: string): string {
  return encodeURIComponent(repoId);
}

export function legacyRepoToDir(repoId: string): string {
  return repoId.replace(/\//g, '_');
}

export function repoDirCandidates(repoId: string): string[] {
  const primary = safeRepoToDir(repoId);
  const legacy = legacyRepoToDir(repoId);
  return primary === legacy ? [primary] : [primary, legacy];
}
