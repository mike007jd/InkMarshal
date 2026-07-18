export interface RelationDraftLike {
  targetId: string;
  relationType: string;
  label: string;
}

export interface KnowledgeRelationLike {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  label: string;
}

export interface RelationSyncCreateInput {
  targetId: string;
  relationType: string;
  label: string;
}

export interface RelationSyncPlan {
  deleteIds: string[];
  creates: RelationSyncCreateInput[];
}

export function shouldSeedRelationDrafts(input: {
  draftsSeeded: boolean;
  editingEntryId?: string;
  existingRelationsLoaded: boolean;
  existingRelationCount: number;
  suggestedRelationCount: number;
  hasInitialPrefill: boolean;
}): boolean {
  if (input.draftsSeeded) return false;
  if (input.editingEntryId && !input.existingRelationsLoaded) return false;
  if (input.existingRelationCount > 0 || input.suggestedRelationCount > 0) return true;
  return Boolean(input.editingEntryId || input.hasInitialPrefill);
}

export function planKnowledgeRelationDraftSync(
  entryId: string,
  existingRelations: KnowledgeRelationLike[],
  relationDrafts: RelationDraftLike[],
): RelationSyncPlan {
  const existingByKey = new Map<string, KnowledgeRelationLike>();
  for (const relation of existingRelations) {
    if (relation.sourceId !== entryId) continue;
    existingByKey.set(relationKey(relation.targetId, relation.relationType, relation.label), relation);
  }

  const draftKeys = new Set<string>();
  const creates: RelationSyncCreateInput[] = [];
  for (const draft of relationDrafts) {
    if (!draft.targetId) continue;
    const key = relationKey(draft.targetId, draft.relationType, draft.label);
    draftKeys.add(key);
    if (!existingByKey.has(key)) {
      creates.push({
        targetId: draft.targetId,
        relationType: draft.relationType || 'friend',
        label: draft.label,
      });
    }
  }

  const deleteIds: string[] = [];
  for (const [key, relation] of existingByKey) {
    if (!draftKeys.has(key)) deleteIds.push(relation.id);
  }

  return { deleteIds, creates };
}

function relationKey(targetId: string, relationType: string, label: string): string {
  return `${targetId}|${relationType || 'friend'}|${label}`;
}
