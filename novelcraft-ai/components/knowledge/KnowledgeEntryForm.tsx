'use client';

import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { X, Save, Sparkles } from 'lucide-react';
import {
  createKnowledgeEntry,
  updateKnowledgeEntry,
  syncKnowledgeRelationDrafts,
} from '@/app/actions/knowledge';
import { useLocale } from '@/components/LanguageProvider';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatStyleNotes, type StyleNotes } from '@/lib/ai/style-extractor';
import { RelationsEditor, type RelationDraft } from '@/components/knowledge/RelationsEditor';
import { WikilinkPill } from '@/components/knowledge/WikilinkPill';
import { shouldSeedRelationDrafts } from '@/lib/knowledge/relation-drafts';
import { parseWikilinks } from '@/lib/vault/wikilink';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Translations } from '@/lib/i18n';
import type {
  KnowledgeEntry,
  KnowledgeRelation,
  KnowledgeType,
  CharacterData,
  WorldData,
  TimelineData,
  OutlineData,
  StyleReferenceData,
} from '@/lib/types/knowledge';
import { KNOWLEDGE_FIELD_LIMITS, KNOWLEDGE_TYPES } from '@/lib/types/knowledge';

/**
 * Prefill shape accepted by the form for both "extract from conversation"
 * and any future bulk-import path. All fields optional — the form falls
 * back to its empty defaults for any missing key.
 */
export interface KnowledgeEntryPrefill {
  type?: KnowledgeType;
  title?: string;
  summary?: string;
  data?: Record<string, unknown>;
  tags?: string[];
  suggestedWikilinks?: string[];
  suggestedRelations?: Array<{
    /** Either a vault entry id (preferred) or a title string. */
    targetId?: string;
    target?: string;
    type?: string;
    label?: string;
  }>;
}

interface KnowledgeEntryFormProps {
  novelId: string;
  entry?: KnowledgeEntry;
  /** Optional initial prefill — used by ConversationThread extraction flow. */
  initialPrefill?: KnowledgeEntryPrefill;
  onClose: () => void;
  onSaved: () => void;
}

function getTypeLabel(type: KnowledgeType, t: Translations): string {
  const map: Record<KnowledgeType, keyof Translations> = {
    character: 'knowledgeTypeCharacter',
    world: 'knowledgeTypeWorld',
    timeline: 'knowledgeTypeTimeline',
    outline: 'knowledgeTypeOutline',
    style_reference: 'knowledgeTypeStyleReference',
  };
  return t[map[type]] as string;
}

const DEFAULT_DATA: Record<KnowledgeType, CharacterData | WorldData | TimelineData | OutlineData | StyleReferenceData> = {
  character: { role: 'supporting', description: '', backstory: '', motivation: '', traits: [], arc: '', aliases: [] },
  world: { category: 'location', description: '', details: {} },
  timeline: { date: '', dateSort: 0, eventType: 'plot', description: '', chapterIds: [], characterRefs: [], importance: 'minor' },
  outline: { chapterId: '', chapterNumber: 1, synopsis: '', keyEvents: [], characters: [], pov: '', status: 'planned', wordCountTarget: 0, notes: '', level: 'chapter', parentId: '', sceneMeta: { pov: '', time: '', location: '', conflict: '', outcome: '' }, plotlineTags: [], characterArcTags: [], customMeta: {} },
  style_reference: { sampleText: '', styleNotes: '', source: '' },
};

function splitBoundedShortList(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim().slice(0, KNOWLEDGE_FIELD_LIMITS.shortText))
    .filter(Boolean)
    .slice(0, KNOWLEDGE_FIELD_LIMITS.shortListItems);
}

function splitBoundedTagList(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim().slice(0, KNOWLEDGE_FIELD_LIMITS.tagText))
    .filter(Boolean)
    .slice(0, KNOWLEDGE_FIELD_LIMITS.shortListItems);
}

function makeRelationDraftKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function relationsToDrafts(
  rels: KnowledgeRelation[],
  entryMap: Map<string, KnowledgeEntry>,
  selfId: string,
): RelationDraft[] {
  return rels.filter(r => r.sourceId === selfId).map(r => {
    const otherId = r.targetId;
    const other = entryMap.get(otherId);
    return {
      key: r.id || makeRelationDraftKey(),
      targetId: otherId,
      targetTitle: other?.title ?? '',
      relationType: r.relationType,
      label: r.label,
    };
  });
}

function resolveInitialType(entry?: KnowledgeEntry, initialPrefill?: KnowledgeEntryPrefill): KnowledgeType {
  return entry?.type ?? initialPrefill?.type ?? 'character';
}

function resolveInitialData(
  type: KnowledgeType,
  entry?: KnowledgeEntry,
  initialPrefill?: KnowledgeEntryPrefill,
): Record<string, unknown> {
  if (entry) return { ...entry.data };
  const base = { ...DEFAULT_DATA[type] } as Record<string, unknown>;
  if (initialPrefill?.data) Object.assign(base, initialPrefill.data);
  return base;
}

export function KnowledgeEntryForm({ novelId, entry, initialPrefill, onClose, onSaved }: KnowledgeEntryFormProps) {
  const { t } = useLocale();
  const { toast } = useToast();
  const isEditing = !!entry;
  const formScope = `${novelId}:${entry?.id ?? 'new'}`;

  const initialType: KnowledgeType = resolveInitialType(entry, initialPrefill);
  const [type, setType] = useState<KnowledgeType>(initialType);
  const [title, setTitle] = useState(entry?.title ?? initialPrefill?.title ?? '');
  const [tagsStr, setTagsStr] = useState(
    (entry?.tags ?? initialPrefill?.tags ?? []).join(', '),
  );
  const [data, setData] = useState<Record<string, unknown>>(() => {
    return resolveInitialData(initialType, entry, initialPrefill);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Target picker pool: character + world entries from the same novel.
  const [targetEntries, setTargetEntries] = useState<KnowledgeEntry[]>([]);
  const [existingRelations, setExistingRelations] = useState<KnowledgeRelation[]>([]);
  const [relationsLoadedForEntryId, setRelationsLoadedForEntryId] = useState<string | null>(entry?.id ? null : '');
  const [relationDrafts, setRelationDrafts] = useState<RelationDraft[]>([]);
  const [draftsSeededForEntryId, setDraftsSeededForEntryId] = useState<string | null>(null);
  const activeNovelRef = useRef(novelId);
  const activeFormScopeRef = useRef(formScope);
  const savingRef = useRef(false);
  const saveSeqRef = useRef(0);

  useLayoutEffect(() => {
    activeNovelRef.current = novelId;
    activeFormScopeRef.current = formScope;
  }, [novelId, formScope]);

  useEffect(() => {
    const nextType = resolveInitialType(entry, initialPrefill);
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setType(nextType);
      setTitle(entry?.title ?? initialPrefill?.title ?? '');
      setTagsStr((entry?.tags ?? initialPrefill?.tags ?? []).join(', '));
      setData(resolveInitialData(nextType, entry, initialPrefill));
      setSaving(false);
      savingRef.current = false;
      saveSeqRef.current += 1;
      setError('');
      setTargetEntries([]);
      setExistingRelations([]);
      setRelationsLoadedForEntryId(entry?.id ? null : '');
      setRelationDrafts([]);
      setDraftsSeededForEntryId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [novelId, entry, initialPrefill]);

  // Load potential relation targets once; the user may add/remove relations
  // while the form is open so we want a snapshot at first render.
  useEffect(() => {
    const requestNovelId = novelId;
    let cancelled = false;
    async function loadTargets() {
      try {
        const [chars, worlds] = await Promise.all([
          fetch(`/api/novels/${novelId}/knowledge?type=character`).then(r => (r.ok ? r.json() : [])),
          fetch(`/api/novels/${novelId}/knowledge?type=world`).then(r => (r.ok ? r.json() : [])),
        ]);
        if (cancelled) return;
        const merged = [
          ...(Array.isArray(chars) ? chars : []),
          ...(Array.isArray(worlds) ? worlds : []),
        ] as KnowledgeEntry[];
        if (activeNovelRef.current === requestNovelId) setTargetEntries(merged);
      } catch {
        // Non-fatal — the picker degrades to manual title entry.
      }
    }
    void loadTargets();
    return () => { cancelled = true; };
  }, [novelId]);

  // For editing flows, fetch existing relations to seed the editor.
  useEffect(() => {
    const requestNovelId = novelId;
    let cancelled = false;
    async function loadRelations() {
      if (!entry?.id) {
        queueMicrotask(() => {
          if (!cancelled && activeNovelRef.current === requestNovelId) {
            setExistingRelations([]);
            setRelationsLoadedForEntryId('');
          }
        });
        return;
      }
      queueMicrotask(() => {
        if (!cancelled && activeNovelRef.current === requestNovelId) {
          setExistingRelations([]);
          setRelationsLoadedForEntryId(null);
        }
      });
      try {
        const res = await fetch(`/api/novels/${novelId}/knowledge/${entry.id}`);
        if (!res.ok) {
          if (!cancelled && activeNovelRef.current === requestNovelId) setRelationsLoadedForEntryId(entry.id);
          return;
        }
        const json = (await res.json()) as KnowledgeEntry & { relations?: KnowledgeRelation[] };
        if (cancelled || activeNovelRef.current !== requestNovelId) return;
        const rels = Array.isArray(json.relations) ? json.relations : [];
        setExistingRelations(rels);
        setRelationsLoadedForEntryId(entry.id);
      } catch {
        if (!cancelled && entry?.id && activeNovelRef.current === requestNovelId) setRelationsLoadedForEntryId(entry.id);
        // Ignore — empty list keeps the editor usable.
      }
    }
    void loadRelations();
    return () => { cancelled = true; };
  }, [entry?.id, novelId]);

  const targetEntriesMap = useMemo(() => {
    const m = new Map<string, KnowledgeEntry>();
    for (const e of targetEntries) m.set(e.id, e);
    return m;
  }, [targetEntries]);

  // Seed relationDrafts once dependencies are settled (entry + existing rels +
  // target pool). We deliberately depend only on the seed inputs; user edits
  // are kept in `relationDrafts` and survive re-render.
  useEffect(() => {
    const seedKey = entry?.id ?? 'new';
    const draftsSeeded = draftsSeededForEntryId === seedKey;
    const suggestedRelationCount = initialPrefill?.suggestedRelations?.length ?? 0;
    const existingRelationsLoaded = entry?.id ? relationsLoadedForEntryId === entry.id : true;
    const seedableExistingRelations = existingRelationsLoaded ? existingRelations : [];
    if (!shouldSeedRelationDrafts({
      draftsSeeded,
      editingEntryId: entry?.id,
      existingRelationsLoaded,
      existingRelationCount: seedableExistingRelations.length,
      suggestedRelationCount,
      hasInitialPrefill: Boolean(initialPrefill),
    })) return;
    const seed: RelationDraft[] = [];
    if (entry?.id) {
      seed.push(...relationsToDrafts(seedableExistingRelations, targetEntriesMap, entry.id));
    }
    if (initialPrefill?.suggestedRelations && initialPrefill.suggestedRelations.length > 0) {
      for (const r of initialPrefill.suggestedRelations) {
        const targetTitle = r.target ?? '';
        const resolvedTarget = r.targetId
          ?? targetEntries.find(entry => entry.title.trim().toLowerCase() === targetTitle.trim().toLowerCase())?.id
          ?? '';
        seed.push({
          key: makeRelationDraftKey(),
          targetId: resolvedTarget,
          targetTitle,
          relationType: r.type ?? 'friend',
          label: r.label ?? '',
        });
      }
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setRelationDrafts(seed);
      setDraftsSeededForEntryId(seedKey);
    });
    return () => {
      cancelled = true;
    };
  }, [draftsSeededForEntryId, entry, initialPrefill, existingRelations, targetEntries, targetEntriesMap, relationsLoadedForEntryId]);

  const handleTypeChange = useCallback((newType: KnowledgeType) => {
    setType(newType);
    setData({ ...DEFAULT_DATA[newType] });
  }, []);

  const updateField = useCallback((field: string, value: unknown) => {
    setData(prev => ({ ...prev, [field]: value }));
  }, []);

  /**
   * Reconcile the relation drafts to the stored relations in ONE atomic server
   * action (KN-01): the server diffs the desired final set against the DB and
   * applies every delete + create in a single transaction, so a mid-sync failure
   * can no longer leave the relation set partially updated. Fully-empty rows
   * (no resolved target) are dropped here — they carry no relation.
   */
  const syncRelations = useCallback(async (entryId: string) => {
    const drafts = relationDrafts
      .filter(draft => draft.targetId)
      .map(draft => ({
        targetId: draft.targetId,
        relationType: draft.relationType,
        label: draft.label,
      }));
    await syncKnowledgeRelationDrafts(entryId, drafts);
  }, [relationDrafts]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const requestNovelId = novelId;
    const requestFormScope = formScope;
    if (savingRef.current) return;
    if (!title.trim()) {
      setError(t.knowledgeEntryTitleRequired as string);
      return;
    }

    // Block relation rows that would silently lose the user's input: a typed
    // target that never resolved to a vault entry is dropped by persist, and a
    // resolved target with the type cleared is meaningless. Fully-empty rows are
    // left alone (harmlessly ignored on save).
    if (type === 'character') {
      const badIndex = relationDrafts.findIndex(r =>
        (!r.targetId && r.targetTitle.trim().length > 0) ||
        (Boolean(r.targetId) && !r.relationType.trim()),
      );
      if (badIndex >= 0) {
        setError((t.relationsEditorIncomplete as string).replace('{n}', String(badIndex + 1)));
        return;
      }
    }

    savingRef.current = true;
    const requestSeq = ++saveSeqRef.current;
    setSaving(true);
    setError('');

    try {
      const tags = splitBoundedTagList(tagsStr);

      let savedId = entry?.id ?? '';
      if (isEditing && entry) {
        await updateKnowledgeEntry(entry.id, { title, data, tags });
      } else {
        const created = await createKnowledgeEntry(novelId, { type, title, tags, data });
        savedId = (created as { id: string }).id;
      }

      if (savedId && type === 'character') {
        await syncRelations(savedId);
      }
      if (
        activeNovelRef.current === requestNovelId &&
        activeFormScopeRef.current === requestFormScope
      ) onSaved();
    } catch (err) {
      if (
        activeNovelRef.current === requestNovelId &&
        activeFormScopeRef.current === requestFormScope
      ) {
        setError(err instanceof Error ? err.message : t.knowledgeEntrySaveFailed as string);
        toast(err instanceof Error ? err.message : t.knowledgeEntrySaveFailed as string, 'error');
      }
    } finally {
      if (saveSeqRef.current === requestSeq) savingRef.current = false;
      if (
        activeNovelRef.current === requestNovelId &&
        activeFormScopeRef.current === requestFormScope
      ) setSaving(false);
    }
  };

  // Residual layout-only overrides on top of the `boxed` Input/Textarea
  // variant — restores this form's bg-secondary + px-3/py-2 + ring-accent
  // focus exactly (cn-merge wins over the variant's bg-card/px-2/py-1.5).
  const inputClass =
    'w-full bg-book-bg-secondary px-3 py-2 text-sm placeholder:text-book-ink-muted focus:ring-2 focus:ring-book-accent';
  // Select uses the C1 default trigger + a full box override + the
  // `focus:border-b-book-border` underline-focus cancel (C2.S1 convention).
  const selectTriggerClass =
    'h-auto w-full rounded-md border border-book-border bg-book-bg-secondary px-3 py-2 text-sm text-book-ink-primary focus:border-b-book-border focus:ring-2 focus:ring-book-accent';
  const labelClass = 'block text-xs font-medium text-book-ink-secondary mb-1';
  const textareaClass = `${inputClass} min-h-[80px] resize-y`;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-serif font-semibold text-book-ink-primary">
          {isEditing ? t.knowledgeEditEntry : t.knowledgeNewEntry}
        </h3>
        <Button
          variant="unstyled"
          size="unstyled"
          type="button"
          onClick={onClose}
          aria-label={t.dismiss}
          className="rounded p-1 text-book-ink-muted hover:bg-book-bg-secondary hover:text-book-ink-primary"
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </div>

      {/* Type selector */}
      {!isEditing && (
        <div>
          <label className={labelClass}>{t.knowledgeEntryType}</label>
          <Select
            value={type}
            onValueChange={v => handleTypeChange(v as KnowledgeType)}
          >
            <SelectTrigger className={selectTriggerClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KNOWLEDGE_TYPES.map(kt => (
                <SelectItem key={kt} value={kt}>
                  {getTypeLabel(kt, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Title */}
      <div>
        <label className={labelClass}>{t.knowledgeEntryTitle}</label>
        <Input
          variant="boxed"
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder={t.knowledgeEntryTitlePlaceholder as string}
          className={inputClass}
          maxLength={KNOWLEDGE_FIELD_LIMITS.shortText}
          required
        />
      </div>

      {/* Tags */}
      <div>
        <label className={labelClass}>{t.knowledgeEntryTags}</label>
        <Input
          variant="boxed"
          type="text"
          value={tagsStr}
          onChange={e => setTagsStr(e.target.value)}
          placeholder={t.knowledgeEntryTagsPlaceholder as string}
          className={inputClass}
          maxLength={(KNOWLEDGE_FIELD_LIMITS.tagText + 2) * KNOWLEDGE_FIELD_LIMITS.shortListItems}
        />
      </div>

      {/* Dynamic fields by type */}
      {type === 'character' && (
        <CharacterFields data={data} updateField={updateField} inputClass={inputClass} selectTriggerClass={selectTriggerClass} labelClass={labelClass} textareaClass={textareaClass} t={t} />
      )}
      {type === 'world' && (
        <WorldFields data={data} updateField={updateField} inputClass={inputClass} selectTriggerClass={selectTriggerClass} labelClass={labelClass} textareaClass={textareaClass} t={t} />
      )}
      {type === 'timeline' && (
        <TimelineFields data={data} updateField={updateField} inputClass={inputClass} selectTriggerClass={selectTriggerClass} labelClass={labelClass} textareaClass={textareaClass} t={t} />
      )}
      {type === 'outline' && (
        <OutlineFields data={data} updateField={updateField} inputClass={inputClass} selectTriggerClass={selectTriggerClass} labelClass={labelClass} textareaClass={textareaClass} t={t} />
      )}
      {type === 'style_reference' && (
        <StyleReferenceFields data={data} updateField={updateField} inputClass={inputClass} selectTriggerClass={selectTriggerClass} labelClass={labelClass} textareaClass={textareaClass} t={t} scopeKey={formScope} />
      )}

      {/* Relations editor — characters only (per plan §4.4 trade-off). */}
      {type === 'character' && (
        <div>
          <label className={labelClass}>{t.relationsHeader as string}</label>
          <RelationsEditor
            novelId={novelId}
            targetEntries={targetEntries}
            excludeId={entry?.id}
            value={relationDrafts}
            onChange={setRelationDrafts}
          />
        </div>
      )}

      {/* Wikilink preview — scans description/backstory/motivation/arc for
          [[Target]] tokens so the user can see at a glance which references
          point at known entries vs. unresolved drafts. Clicking an unresolved
          pill seeds a quick-create stub (the actual creation flow opens a
          new form via the parent panel; here we just toast). */}
      {(type === 'character' || type === 'world') && (() => {
        const bodyFields = [
          (data.description as string) || '',
          (data.backstory as string) || '',
          (data.motivation as string) || '',
          (data.arc as string) || '',
        ].join('\n');
        const links = parseWikilinks(bodyFields);
        if (links.length === 0) return null;
        return (
          <div className="flex flex-wrap gap-1.5">
            {links.map(l => {
              const resolved = targetEntries.find(e => e.title.toLowerCase() === l.raw.toLowerCase());
              return (
                <WikilinkPill
                  key={l.raw}
                  raw={l.raw}
                  resolvedId={resolved?.id}
                  onJump={() => {/* navigation handled by parent panel */}}
                  onCreateDraft={(raw) => toast(`${t.wikilinkCreateDraft}: ${raw}`, 'info')}
                />
              );
            })}
          </div>
        );
      })()}

      {/* Error */}
      {error && (
        <p className="text-xs text-book-danger">{error}</p>
      )}

      {/* Submit */}
      <Button
        variant="accent"
        type="submit"
        disabled={saving}
        className="h-auto w-full gap-2 px-4 py-2 text-sm font-medium"
      >
        {saving ? <Spinner size="sm" /> : <Save size={14} />}
        {saving ? t.knowledgeEntrySaving : isEditing ? t.knowledgeEntryUpdate : t.knowledgeEntryCreate}
      </Button>
    </form>
  );
}

/* ---------- Sub-forms per type ---------- */

interface FieldProps {
  data: Record<string, unknown>;
  updateField: (field: string, value: unknown) => void;
  inputClass: string;
  selectTriggerClass: string;
  labelClass: string;
  textareaClass: string;
  t: Translations;
}

function CharacterFields({ data, updateField, inputClass, selectTriggerClass, labelClass, textareaClass, t }: FieldProps) {
  return (
    <>
      <div>
        <label className={labelClass}>{t.knowledgeCharRole}</label>
        <Select value={(data.role as string) || 'supporting'} onValueChange={v => updateField('role', v)}>
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="protagonist">{t.knowledgeCharRoleProtagonist}</SelectItem>
            <SelectItem value="antagonist">{t.knowledgeCharRoleAntagonist}</SelectItem>
            <SelectItem value="supporting">{t.knowledgeCharRoleSupporting}</SelectItem>
            <SelectItem value="minor">{t.knowledgeCharRoleMinor}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeCharDescription}</label>
        <Textarea variant="boxed" value={(data.description as string) || ''} onChange={e => updateField('description', e.target.value)} className={textareaClass} placeholder={t.knowledgeCharDescriptionPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.characterDescription} />
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeCharBackstory}</label>
        <Textarea variant="boxed" value={(data.backstory as string) || ''} onChange={e => updateField('backstory', e.target.value)} className={textareaClass} placeholder={t.knowledgeCharBackstoryPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.characterBackstory} />
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeCharMotivation}</label>
        <Textarea variant="boxed" value={(data.motivation as string) || ''} onChange={e => updateField('motivation', e.target.value)} className={textareaClass} placeholder={t.knowledgeCharMotivationPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.characterMotivation} />
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeCharTraits}</label>
        <Input
          variant="boxed"
          type="text"
          value={Array.isArray(data.traits) ? (data.traits as string[]).join(', ') : ''}
          onChange={e => updateField('traits', splitBoundedShortList(e.target.value))}
          className={inputClass}
          placeholder={t.knowledgeCharTraitsPlaceholder as string}
          maxLength={(KNOWLEDGE_FIELD_LIMITS.shortText + 2) * KNOWLEDGE_FIELD_LIMITS.shortListItems}
        />
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeCharArc}</label>
        <Textarea variant="boxed" value={(data.arc as string) || ''} onChange={e => updateField('arc', e.target.value)} className={textareaClass} placeholder={t.knowledgeCharArcPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.characterArc} />
      </div>
    </>
  );
}

function WorldFields({ data, updateField, selectTriggerClass, labelClass, textareaClass, t }: FieldProps) {
  return (
    <>
      <div>
        <label className={labelClass}>{t.knowledgeWorldCategory}</label>
        <Select value={(data.category as string) || 'location'} onValueChange={v => updateField('category', v)}>
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="location">{t.knowledgeWorldCatLocation}</SelectItem>
            <SelectItem value="faction">{t.knowledgeWorldCatFaction}</SelectItem>
            <SelectItem value="magic_system">{t.knowledgeWorldCatMagicSystem}</SelectItem>
            <SelectItem value="technology">{t.knowledgeWorldCatTechnology}</SelectItem>
            <SelectItem value="culture">{t.knowledgeWorldCatCulture}</SelectItem>
            <SelectItem value="rule">{t.knowledgeWorldCatRule}</SelectItem>
            <SelectItem value="item">{t.knowledgeWorldCatItem}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeWorldDescription}</label>
        <Textarea variant="boxed" value={(data.description as string) || ''} onChange={e => updateField('description', e.target.value)} className={textareaClass} placeholder={t.knowledgeWorldDescriptionPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.worldDescription} />
      </div>
    </>
  );
}

function TimelineFields({ data, updateField, inputClass, selectTriggerClass, labelClass, textareaClass, t }: FieldProps) {
  return (
    <>
      <div>
        <label className={labelClass}>{t.knowledgeTimeDate}</label>
        <Input variant="boxed" type="text" value={(data.date as string) || ''} onChange={e => updateField('date', e.target.value)} className={inputClass} placeholder={t.knowledgeTimeDatePlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.shortText} />
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeTimeEventType}</label>
        <Select value={(data.eventType as string) || 'plot'} onValueChange={v => updateField('eventType', v)}>
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="plot">{t.knowledgeTimeEventPlot}</SelectItem>
            <SelectItem value="character">{t.knowledgeTimeEventCharacter}</SelectItem>
            <SelectItem value="world">{t.knowledgeTimeEventWorld}</SelectItem>
            <SelectItem value="backstory">{t.knowledgeTimeEventBackstory}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeTimeDescription}</label>
        <Textarea variant="boxed" value={(data.description as string) || ''} onChange={e => updateField('description', e.target.value)} className={textareaClass} placeholder={t.knowledgeTimeDescriptionPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.timelineDescription} />
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeTimeImportance}</label>
        <Select value={(data.importance as string) || 'minor'} onValueChange={v => updateField('importance', v)}>
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="major">{t.knowledgeTimeImportanceMajor}</SelectItem>
            <SelectItem value="minor">{t.knowledgeTimeImportanceMinor}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

function OutlineFields({ data, updateField, inputClass, selectTriggerClass, labelClass, textareaClass, t }: FieldProps) {
  return (
    <>
      <div>
        <label className={labelClass}>{t.blueprintChapterLabel}</label>
        <Input
          variant="boxed"
          type="number"
          min={1}
          max={10000}
          value={String((data.chapterNumber as number | undefined) ?? 1)}
          onChange={e => updateField('chapterNumber', Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          className={inputClass}
        />
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeOutlineSynopsis}</label>
        <Textarea variant="boxed" value={(data.synopsis as string) || ''} onChange={e => updateField('synopsis', e.target.value)} className={textareaClass} placeholder={t.knowledgeOutlineSynopsisPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.outlineSynopsis} />
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeOutlinePov}</label>
        <Input variant="boxed" type="text" value={(data.pov as string) || ''} onChange={e => updateField('pov', e.target.value)} className={inputClass} placeholder={t.knowledgeOutlinePovPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.mediumText} />
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeOutlineStatus}</label>
        <Select value={(data.status as string) || 'planned'} onValueChange={v => updateField('status', v)}>
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="planned">{t.knowledgeOutlineStatusPlanned}</SelectItem>
            <SelectItem value="drafted">{t.knowledgeOutlineStatusDrafted}</SelectItem>
            <SelectItem value="revised">{t.knowledgeOutlineStatusRevised}</SelectItem>
            <SelectItem value="final">{t.knowledgeOutlineStatusFinal}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeOutlineNotes}</label>
        <Textarea variant="boxed" value={(data.notes as string) || ''} onChange={e => updateField('notes', e.target.value)} className={textareaClass} placeholder={t.knowledgeOutlineNotesPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.outlineNotes} />
      </div>
    </>
  );
}

function StyleReferenceFields({
  data,
  updateField,
  inputClass,
  labelClass,
  textareaClass,
  t,
  scopeKey,
}: FieldProps & { scopeKey: string }) {
  const { toast } = useToast();
  const { locale } = useLocale();
  const [extracting, setExtracting] = useState(false);
  const extractSeqRef = useRef(0);

  const sampleText = (data.sampleText as string) || '';
  const sampleTextRef = useRef(sampleText);

  useEffect(() => {
    let cancelled = false;
    extractSeqRef.current += 1;
    sampleTextRef.current = sampleText;
    queueMicrotask(() => {
      if (!cancelled) setExtracting(false);
    });
    return () => {
      cancelled = true;
    };
  }, [scopeKey, sampleText]);

  const handleExtract = useCallback(async () => {
    if (extracting) return;
    if (sampleText.trim().length < 80) {
      // Below the model's useful input size — bail without burning a call.
      toast(t.styleExtractFailed as string, 'info');
      return;
    }
    const requestSeq = ++extractSeqRef.current;
    const requestSample = sampleText;
    setExtracting(true);
    try {
      const res = await fetch('/api/knowledge/style-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-locale': locale },
        body: JSON.stringify({ sampleText }),
      });
      if (!res.ok) throw new Error('extract failed');
      const notes = (await res.json()) as StyleNotes & { _modelUnavailable?: boolean };
      if (extractSeqRef.current !== requestSeq || requestSample !== sampleTextRef.current) return;
      // _modelUnavailable: route succeeded but no model was bound — keep the
      // form usable by treating it as a manual-fill prompt.
      if (notes._modelUnavailable) {
        toast(t.styleExtractFailed as string, 'info');
        return;
      }
      const composed = formatStyleNotes(notes, locale);
      if (composed) {
        updateField('styleNotes', composed);
      } else {
        // Model returned the empty profile — too short / refused etc.
        toast(t.styleExtractFailed as string, 'info');
      }
    } catch {
      if (extractSeqRef.current === requestSeq) toast(t.styleExtractFailed as string, 'error');
    } finally {
      if (extractSeqRef.current === requestSeq) setExtracting(false);
    }
  }, [extracting, sampleText, locale, toast, t, updateField]);

  return (
    <>
      <div>
        <label className={labelClass}>{t.styleSampleLabel ?? t.knowledgeStyleSampleText}</label>
        <Textarea variant="boxed" value={sampleText} onChange={e => updateField('sampleText', e.target.value)} className={textareaClass} placeholder={t.knowledgeStyleSampleTextPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.styleSampleText} />
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className={`${labelClass} mb-0`}>{t.knowledgeStyleNotes}</label>
          {/* Auto-extract button — only useful when there's a sample to read.
              On failure (network, no model bound, short input) we fall back to
              "manual fill" via toast; the user can still type styleNotes by
              hand. The button never blocks the form submit. */}
          <Button
            variant="ghost"
            type="button"
            size="sm"
            disabled={extracting || sampleText.trim().length < 80}
            onClick={handleExtract}
            className="h-auto gap-1.5 px-2 py-1 text-xs"
          >
            {extracting ? <Spinner size="sm" /> : <Sparkles className="h-3.5 w-3.5" />}
            {t.styleExtractButton}
          </Button>
        </div>
        <Textarea variant="boxed" value={(data.styleNotes as string) || ''} onChange={e => updateField('styleNotes', e.target.value)} className={textareaClass} placeholder={t.knowledgeStyleNotesPlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.styleNotes} />
      </div>
      <div>
        <label className={labelClass}>{t.knowledgeStyleSource}</label>
        <Input variant="boxed" type="text" value={(data.source as string) || ''} onChange={e => updateField('source', e.target.value)} className={inputClass} placeholder={t.knowledgeStyleSourcePlaceholder as string} maxLength={KNOWLEDGE_FIELD_LIMITS.shortText} />
      </div>
    </>
  );
}
