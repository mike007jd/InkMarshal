// Wave 2 commit B — shared TypeScript types for the FS-backed vault layer.
//
// Kept intentionally small + dependency-free so any module (Server Actions,
// client hooks, Rust IPC wrappers) can import without pulling in zod or db
// internals.

import type {
  CharacterData,
  WorldData,
  TimelineData,
  OutlineData,
  KnowledgeType,
} from '@/lib/types/knowledge';

export type { KnowledgeType };

/** One row coming back from the SQLite `knowledge_index` table. */
export interface VaultIndexRow {
  id: string;
  novelId: string;
  type: KnowledgeType;
  path: string;
  title: string;
  tags: string[];
  aliases: string[];
  importance: 'low' | 'normal' | 'high' | null;
  data: Record<string, unknown>;
  outgoingLinks: OutgoingLink[];
  contentHash: string;
  updatedAt: string; // ISO-8601
}

/** Single Obsidian-style `[[Target]]` reference found inside an entry body. */
export interface OutgoingLink {
  /** The raw text inside the brackets (preserves original casing). */
  raw: string;
  /** The resolved entry id once a vault-walk has matched the link. */
  resolvedId?: string;
}

/** YAML frontmatter common across every entry type. */
export interface VaultFrontmatterCommon {
  id: string;
  type: KnowledgeType;
  title: string;
  tags?: string[];
  aliases?: string[];
  importance?: 'low' | 'normal' | 'high';
  createdAt?: string;
  updatedAt?: string;
}

/** Frontmatter shape per entry type. */
export type VaultFrontmatter = VaultFrontmatterCommon &
  Partial<{
    role: CharacterData['role'];
    description: string;
    backstory: string;
    motivation: string;
    traits: string[];
    arc: string;
    category: WorldData['category'];
    details: Record<string, string>;
    date: string;
    dateSort: number;
    eventType: TimelineData['eventType'];
    chapterIds: string[];
    characterRefs: string[];
    chapterId: string;
    chapterNumber: number;
    synopsis: string;
    keyEvents: string[];
    characters: string[];
    pov: string;
    status: OutlineData['status'];
    wordCountTarget: number;
    notes: string;
    // W3-1 outline hierarchy fields. The render/parse round-trip is generic
    // (spreads non-core data keys into frontmatter and back), so these only need
    // to be declared here for type-safety; no serializer change is required.
    level: OutlineData['level'];
    parentId: string;
    sceneMeta: OutlineData['sceneMeta'];
    plotlineTags: string[];
    characterArcTags: string[];
    customMeta: Record<string, string>;
    sampleText: string;
    styleNotes: string;
    source: string;
    /** Optional structured relations (writes both wikilinks + this array). */
    relations: RelationFrontmatter[];
  }>;

export interface RelationFrontmatter {
  target: string; // title of the related entry
  type: string;
  label?: string;
}

/** Result of parsing a vault `.md` file into structured form. */
export interface ParsedEntryFile {
  frontmatter: VaultFrontmatter;
  body: string;
  /** Non-fatal warnings (e.g. unknown frontmatter key, malformed list). */
  warnings: string[];
}

/** What `vault_walk` returns from Rust per file. */
export interface VaultFileMeta {
  path: string;
  contentHash: string;
  mtimeMs: number;
  size: number;
}

export interface VaultReadResult {
  content: string;
  contentHash: string;
  mtimeMs: number;
}

export interface VaultWriteResult {
  contentHash: string;
  mtimeMs: number;
  size: number;
}

export interface VaultReachable {
  reachable: boolean;
  writable: boolean;
  error?: string | null;
}

export interface VaultChangedEvent {
  novelId: string;
  paths: string[];
  kind: 'create' | 'modify' | 'rename' | 'remove' | 'other';
}

/** Per-novel state stored in SQLite alongside the vault path. */
export interface NovelVaultRow {
  vaultPath: string | null;
  vaultVersion: number;
}

/** Bridge type the existing app code expects (lib/knowledge.ts, etc). */
export interface KnowledgeEntryProjection {
  id: string;
  novelId: string;
  type: KnowledgeType;
  title: string;
  summary: string;
  data: Record<string, unknown>;
  sortOrder: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}
