'use client';

// Wave 2 commit E — inline editor for the structured "Relations" block of
// a character knowledge entry.
//
// Each row binds one (target, type, label) tuple to a candidate target entry.
// Targets are picked from a list of character + world entries pre-loaded by
// the caller; the relation type is either one of `RELATION_PRESETS` or a
// custom free-text string (mirrors Obsidian's permissive vocabulary).
//
// The editor is dumb / controlled — the caller owns the array and decides
// whether to persist drafts immediately (edit flow) or save them in one shot
// (create flow). This keeps the create path simple: the form holds drafts in
// memory until the entry is created, then batch-writes the relations.

import { Plus, Trash2 } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLocale } from '@/components/LanguageProvider';
import type { KnowledgeEntry } from '@/lib/types/knowledge';
import {
  RELATION_PRESETS,
  RELATION_PRESET_I18N,
  isRelationPreset,
  type RelationPreset,
} from '@/lib/types/knowledge-relations';

/** One relation draft. `targetId` may be null for free-form targets the user
 *  hasn't bound to a vault entry yet (matches the frontmatter shape where a
 *  `target` field is just a title string). */
export interface RelationDraft {
  /** Stable client id so React keys survive reorder. */
  key: string;
  /** Resolved vault entry id (preferred) or empty when unresolved. */
  targetId: string;
  /** Title fallback when targetId is empty. Always populated for prefill flows. */
  targetTitle: string;
  /** Either a `RELATION_PRESETS` value or arbitrary user text. */
  relationType: string;
  /** Optional short note ("兄妹", "ally since ch.3"). */
  label: string;
}

export interface RelationsEditorProps {
  novelId: string;
  /** Pool to pick targets from (character + world). Caller fetches/caches. */
  targetEntries: Pick<KnowledgeEntry, 'id' | 'title' | 'type'>[];
  /** Optional id to exclude from the picker (self-relations don't make sense). */
  excludeId?: string;
  value: RelationDraft[];
  onChange: (next: RelationDraft[]) => void;
}

const CUSTOM_SENTINEL = '__custom__';

function nextKey(): string {
  // crypto.randomUUID is fine in modern browsers / Node; tests get a polyfill via crypto.
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

export function RelationsEditor({
  targetEntries,
  excludeId,
  value,
  onChange,
}: RelationsEditorProps) {
  const { t } = useLocale();
  const pickable = excludeId ? targetEntries.filter(e => e.id !== excludeId) : targetEntries;

  const inputClass =
    'w-full bg-book-bg-secondary px-3 py-2 text-sm placeholder:text-book-ink-muted focus:ring-2 focus:ring-book-accent';
  const selectTriggerClass =
    'h-auto w-full rounded-md border border-book-border bg-book-bg-secondary px-3 py-2 text-sm text-book-ink-primary focus:border-b-book-border focus:ring-2 focus:ring-book-accent';

  const handleAdd = () => {
    onChange([
      ...value,
      { key: nextKey(), targetId: '', targetTitle: '', relationType: 'friend', label: '' },
    ]);
  };
  const handleRemove = (key: string) => {
    onChange(value.filter(r => r.key !== key));
  };
  const handlePatch = (key: string, patch: Partial<RelationDraft>) => {
    onChange(value.map(r => (r.key === key ? { ...r, ...patch } : r)));
  };

  return (
    <div className="space-y-3">
      {value.length === 0 && (
        <p className="text-xs text-book-ink-muted">{t.relationsEmpty as string}</p>
      )}
      {value.map(rel => {
        // Determine whether to show preset dropdown or a free-text input.
        const isPreset = isRelationPreset(rel.relationType);
        return (
          <div
            key={rel.key}
            className="grid grid-cols-12 gap-2 rounded-md border border-book-border bg-book-bg-primary p-2"
          >
            {/* Target picker */}
            <div className="col-span-5">
              <Select
                value={rel.targetId || (rel.targetTitle ? CUSTOM_SENTINEL : '')}
                onValueChange={v => {
                  if (v === CUSTOM_SENTINEL) {
                    handlePatch(rel.key, { targetId: '' });
                  } else {
                    const entry = pickable.find(e => e.id === v);
                    handlePatch(rel.key, {
                      targetId: v,
                      targetTitle: entry?.title ?? rel.targetTitle,
                    });
                  }
                }}
              >
                <SelectTrigger className={selectTriggerClass} aria-label={t.relationsEditorTargetPlaceholder as string}>
                  <SelectValue placeholder={t.relationsEditorTargetPlaceholder as string} />
                </SelectTrigger>
                <SelectContent>
                  {pickable.map(e => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.title || t.knowledgeEntryTitle as string}
                    </SelectItem>
                  ))}
                  {/* Allow keeping a free-text title when no vault entry exists yet. */}
                  {rel.targetTitle && !rel.targetId && (
                    <SelectItem value={CUSTOM_SENTINEL}>
                      {rel.targetTitle}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              {!rel.targetId && (
                <Input
                  variant="boxed"
                  type="text"
                  value={rel.targetTitle}
                  onChange={e => handlePatch(rel.key, { targetTitle: e.target.value })}
                  placeholder={t.relationsEditorTargetPlaceholder as string}
                  className={`${inputClass} mt-2`}
                />
              )}
            </div>

            {/* Relation type select + custom-text fallback */}
            <div className="col-span-3">
              <Select
                value={isPreset ? rel.relationType : CUSTOM_SENTINEL}
                onValueChange={v => {
                  if (v === CUSTOM_SENTINEL) {
                    // Leave existing custom text or seed it.
                    if (isPreset) handlePatch(rel.key, { relationType: '' });
                  } else {
                    handlePatch(rel.key, { relationType: v as RelationPreset });
                  }
                }}
              >
                <SelectTrigger className={selectTriggerClass} aria-label={t.relationsEditorTypePlaceholder as string}>
                  <SelectValue placeholder={t.relationsEditorTypePlaceholder as string} />
                </SelectTrigger>
                <SelectContent>
                  {RELATION_PRESETS.map(p => (
                    <SelectItem key={p} value={p}>
                      {t[RELATION_PRESET_I18N[p]] as string}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_SENTINEL}>
                    {t[RELATION_PRESET_I18N.custom] as string}
                  </SelectItem>
                </SelectContent>
              </Select>
              {!isPreset && (
                <Input
                  variant="boxed"
                  type="text"
                  value={rel.relationType}
                  onChange={e => handlePatch(rel.key, { relationType: e.target.value })}
                  placeholder={t.relationsEditorTypePlaceholder as string}
                  className={`${inputClass} mt-2`}
                />
              )}
            </div>

            {/* Label */}
            <div className="col-span-3">
              <Input
                variant="boxed"
                type="text"
                value={rel.label}
                onChange={e => handlePatch(rel.key, { label: e.target.value })}
                placeholder={t.relationsEditorLabelPlaceholder as string}
                className={inputClass}
              />
            </div>

            {/* Delete */}
            <div className="col-span-1 flex items-start justify-end">
              <Button
                variant="unstyled"
                size="unstyled"
                type="button"
                aria-label={t.relationsEditorDelete as string}
                onClick={() => handleRemove(rel.key)}
                className="rounded p-2 text-book-ink-muted transition-colors hover:bg-book-bg-secondary hover:text-book-danger"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        );
      })}
      <Button
        variant="ghost"
        type="button"
        size="sm"
        onClick={handleAdd}
        className="h-auto gap-1 px-2 py-1 text-xs"
      >
        <Plus className="h-3.5 w-3.5" />
        {t.relationsEditorAddButton as string}
      </Button>
    </div>
  );
}
