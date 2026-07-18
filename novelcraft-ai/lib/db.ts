// Data layer for the local-first desktop app.
//
// Aggregates the split SQLite data layer in `lib/db/` (queries-novel,
// queries-chapter, queries-knowledge, queries-conversation, transactions) plus
// the client-safe type/stage modules. API routes and lib modules import the
// core novel/chapter/knowledge/conversation functions from `@/lib/db`; the
// underlying split is an implementation detail.
//
// DELIBERATE BOUNDARY: the vault-index + embedding sub-layer
// (`queries-vault`, `queries-knowledge-vault`, and the embedding helpers) is NOT
// re-exported here. It is a cohesive sub-module consumed directly by the
// `lib/knowledge/*` and `lib/vault/*` code that owns it (e.g.
// `upsertKnowledgeIndex`, `getKnowledgeIndexById`, `deleteKnowledgeEmbedding`).
// Import those from their own module rather than expecting them on this barrel.
//
// Server-only — the query modules load the native better-sqlite3 addon.

export type {
  ChapterBlueprintEntry,
  NovelBlueprint,
  ChapterKeyFacts,
  ChapterQualityIssue,
  ChapterGenerationMeta,
  ChapterSnapshot,
  UnificationEdit,
  UnificationReport,
  Novel,
  Message,
  Chapter,
  ChapterLite,
  WritingLockInfo,
  ChapterMetaUpdate,
} from '@/lib/db-types';

// Re-export the stage type + policy from the client-safe module so server-side
// callers can keep importing everything novel-related from `lib/db.ts`.
export {
  isInStages,
  STAGES_THAT_CAN_REGENERATE_BLUEPRINT,
  STAGES_THAT_CAN_START_WRITING,
  STAGES_THAT_CAN_UNIFY,
  STAGES_THAT_SHOW_BLUEPRINT_PANEL,
  STAGES_THAT_SHOW_UNIFICATION_PANEL,
  type NovelStage,
} from '@/lib/novel-stages';

// Data functions — re-exported directly from the split data layer in `lib/db/`.
// Server-only: the underlying modules load the native better-sqlite3 addon, so
// never import this module from client code.
export {
  getNovels,
  getActiveNovels,
  getTrashedNovels,
  getNovel,
  getActiveNovel,
  isNovelTrashed,
  trashNovel,
  restoreTrashedNovel,
  deleteTrashedNovelPermanently,
  verifyNovelOwnership,
  createNovel,
  createBlankNovel,
  createNovelWithOpeningMessage,
  updateNovel,
  applyNovelUpdate,
  deleteNovelCascade,
  getNovelBlueprint,
  setNovelBlueprint,
  setNovelBlueprintAfterDeletingChaptersFrom,
  clearNovelBlueprint,
  completeWritingDraft,
  promoteGreenlightDraftWithMessage,
  persistUnificationReportWithMessage,
  getVolumeSummaries,
  appendVolumeSummary,
  acquireWritingLock,
  renewWritingLock,
  releaseWritingLock,
} from '@/lib/db/queries-novel';

export {
  getChapters,
  getChaptersLite,
  upsertChapter,
  getChapter,
  updateChapterContent,
  saveChapterContentVersioned,
  setOriginalContent,
  setChapterOriginalContent,
  clearOriginalContent,
  revertChapterToOriginalContent,
  deleteChaptersFrom,
  updateChapterMeta,
  getMessages,
  addMessage,
  addMessageWithId,
  addMessagePair,
  deleteUserMessage,
  getChatHistory,
  addChatMessage,
  addChatMessagePair,
  addChatMessagePairSync,
  createChapterSnapshot,
  listChapterSnapshots,
  restoreChapterSnapshot,
} from '@/lib/db/queries-chapter';

export {
  getKnowledgeEntries,
  getKnowledgeEntry,
  getKnowledgeEntryById,
  createKnowledgeEntry,
  createKnowledgeEntryWithIndex,
  updateKnowledgeEntry,
  updateKnowledgeEntryWithIndex,
  deleteKnowledgeEntry,
  getKnowledgeEntriesByNovel,
  getKnowledgeEntryIdsByNovel,
  getKnowledgeRelationsByNovel,
  getKnowledgeRelationsByEntry,
  createKnowledgeRelation,
  createKnowledgeRelationWithSourceIndex,
  syncKnowledgeRelationsForSource,
  deleteKnowledgeRelation,
  deleteKnowledgeRelationWithSourceIndex,
  getKnowledgeRelationById,
  reorderOutlineAtomic,
  getOutlineEntries,
  getOutlineWithChapterStatus,
} from '@/lib/db/queries-knowledge';
export type {
  KnowledgeEntryRow,
  KnowledgeRelationRow,
  OutlineEntryRow,
  OutlineWithChapterStatusRow,
} from '@/lib/db/queries-knowledge';

export {
  getConversations,
  getConversation,
  getConversationById,
  createConversation,
  updateConversation,
  deleteConversation,
  getAllConversationsForNovel,
  getConversationsWithTopicForNovel,
  getLatestConversationAssistantMessagesForTopics,
  getMessagesForNovel,
  verifyParentMessageBelongsToNovelLocal,
} from '@/lib/db/queries-conversation';
export type { ConversationRow } from '@/lib/db/queries-conversation';

export { seedNovelData } from '@/lib/db/transactions';
export type {
  SeedKnowledgeEntry,
  SeedConversation,
  SeedMessage,
} from '@/lib/db/transactions';
