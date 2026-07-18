import { describe, expect, it } from 'vitest';
import {
  planKnowledgeRelationDraftSync,
  shouldSeedRelationDrafts,
} from '@/lib/knowledge/relation-drafts';

describe('knowledge relation draft sync', () => {
  it('does not seed an editing form before existing relations have loaded', () => {
    expect(shouldSeedRelationDrafts({
      draftsSeeded: false,
      editingEntryId: 'entry-1',
      existingRelationsLoaded: false,
      existingRelationCount: 0,
      suggestedRelationCount: 0,
      hasInitialPrefill: false,
    })).toBe(false);

    expect(shouldSeedRelationDrafts({
      draftsSeeded: false,
      editingEntryId: 'entry-1',
      existingRelationsLoaded: true,
      existingRelationCount: 1,
      suggestedRelationCount: 0,
      hasInitialPrefill: false,
    })).toBe(true);
  });

  it('plans deletes and creates without unresolved free-text drafts', () => {
    const plan = planKnowledgeRelationDraftSync(
      'source-1',
      [
        {
          id: 'keep-rel',
          sourceId: 'source-1',
          targetId: 'target-1',
          relationType: 'friend',
          label: 'ally',
        },
        {
          id: 'remove-rel',
          sourceId: 'source-1',
          targetId: 'target-2',
          relationType: 'mentor',
          label: '',
        },
      ],
      [
        {
          targetId: 'target-1',
          relationType: 'friend',
          label: 'ally',
        },
        {
          targetId: 'target-3',
          relationType: '',
          label: 'new',
        },
        {
          targetId: '',
          relationType: 'rival',
          label: 'unresolved',
        },
      ],
    );

    expect(plan).toEqual({
      deleteIds: ['remove-rel'],
      creates: [{ targetId: 'target-3', relationType: 'friend', label: 'new' }],
    });
  });

  it('does not recreate an existing friend relation when a draft uses the default blank type', () => {
    const plan = planKnowledgeRelationDraftSync(
      'source-1',
      [{
        id: 'existing-default',
        sourceId: 'source-1',
        targetId: 'target-1',
        relationType: 'friend',
        label: '',
      }],
      [{
        targetId: 'target-1',
        relationType: '',
        label: '',
      }],
    );

    expect(plan).toEqual({ deleteIds: [], creates: [] });
  });
});
