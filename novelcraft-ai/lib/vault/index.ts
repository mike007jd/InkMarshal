// Public barrel for the FS-backed Knowledge Vault.
//
// External callers (Server Actions, hooks, components) only import from this
// file; the granular submodules are an internal organisation detail.

export {
  parseFrontmatter,
  serializeFrontmatter,
} from '@/lib/vault/frontmatter';
export { parseWikilinks } from '@/lib/vault/wikilink';
export { slugifyForFs, uniqueFilename } from '@/lib/vault/filename';
export { hashContent } from '@/lib/vault/content-hash';
export {
  vaultInit,
  vaultWalk,
  vaultReadFile,
  vaultWatchStart,
  vaultWatchStop,
  vaultRevealInFinder,
  vaultReachable,
  VAULT_COMMANDS,
} from '@/lib/vault/ipc';
export {
  parseMarkdownToEntry,
  renderEntryToMarkdown,
  vaultPathFor,
  outgoingLinksFor,
  projectEntryForLegacy,
} from '@/lib/vault/entry';
export type { VaultEntry } from '@/lib/vault/entry';
export type {
  VaultFileMeta,
  VaultReadResult,
  VaultWriteResult,
  VaultReachable,
  VaultChangedEvent,
  VaultFrontmatter,
  VaultFrontmatterCommon,
  RelationFrontmatter,
  OutgoingLink,
  KnowledgeEntryProjection,
  NovelVaultRow,
  VaultIndexRow,
} from '@/lib/vault/types';

/** Suggest a default vault path for a novel: `~/.inkmarshal/app/vaults/{slug}`. */
export async function defaultVaultPathForNovel(slug: string): Promise<string | null> {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return null;
  const { homeDir, join } = await import('@tauri-apps/api/path');
  const home = await homeDir();
  if (!home) return null;
  return join(home, '.inkmarshal', 'app', 'vaults', slug);
}
