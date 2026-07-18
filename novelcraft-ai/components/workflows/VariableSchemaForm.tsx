'use client';

// VariableSchemaForm (W3-2) — the core of the editor.
//
// Authors edit a structured FORM, not the raw prompt. The form is derived from
// the template's `variables_schema` JSON; when that is empty (most seeded rows
// carry `{}`) we fall back to extracting `{{placeholders}}` from the body and
// generate a `string` field per placeholder so the form is never empty. The
// full template text is tucked into an "Advanced" collapsible, hidden by
// default, for power users who want to edit the prose directly.
//
// The component is controlled: it surfaces (templateText, variablesSchema) to
// the parent on every change so Save draft / Publish can persist the result.

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { WorkflowCopy } from '@/components/workflows/workflow-copy';

export interface SchemaField {
  name: string;
  type: 'string' | 'text' | 'number' | 'boolean';
  label?: string;
  description?: string;
  required?: boolean;
}

/** Parse a variables_schema JSON blob into a field list. Tolerates several
 *  shapes: a `{ fields: [...] }` wrapper, a flat `{ name: {type,...} }` map, or
 *  a bare `{}`. */
export function parseSchemaFields(variablesSchema: string): SchemaField[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(variablesSchema || '{}');
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;

  if (Array.isArray(obj.fields)) {
    return (obj.fields as unknown[])
      .map(normalizeField)
      .filter((f): f is SchemaField => f !== null);
  }
  // Flat map: { varName: { type, label } } or { varName: "string" }
  const out: SchemaField[] = [];
  for (const [name, def] of Object.entries(obj)) {
    if (name === 'fields') continue;
    if (typeof def === 'string') {
      out.push({ name, type: coerceType(def) });
    } else if (def && typeof def === 'object') {
      const d = def as Record<string, unknown>;
      out.push({
        name,
        type: coerceType(typeof d.type === 'string' ? d.type : 'string'),
        label: typeof d.label === 'string' ? d.label : undefined,
        description: typeof d.description === 'string' ? d.description : undefined,
        required: d.required === true,
      });
    }
  }
  return out;
}

function normalizeField(raw: unknown): SchemaField | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.name !== 'string' || !d.name) return null;
  return {
    name: d.name,
    type: coerceType(typeof d.type === 'string' ? d.type : 'string'),
    label: typeof d.label === 'string' ? d.label : undefined,
    description: typeof d.description === 'string' ? d.description : undefined,
    required: d.required === true,
  };
}

function coerceType(t: string): SchemaField['type'] {
  if (t === 'text' || t === 'number' || t === 'boolean') return t;
  return 'string';
}

/** Extract `{{var}}` placeholder names from a template body, de-duplicated and
 *  in first-seen order. */
export function extractPlaceholders(template: string): string[] {
  const re = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    // Only the top-level name (before a dot) is a form field; nested paths reuse it.
    const top = m[1].split('.')[0];
    seen.add(top);
  }
  return Array.from(seen);
}

/** The effective field list: declared schema if present, else auto-derived. */
export function deriveFields(variablesSchema: string, templateText: string): SchemaField[] {
  const declared = parseSchemaFields(variablesSchema);
  if (declared.length > 0) return declared;
  return extractPlaceholders(templateText).map((name) => ({ name, type: 'string' as const }));
}

export interface VariableSchemaFormProps {
  copy: WorkflowCopy;
  /** Current template text (controlled). */
  templateText: string;
  /** Current variables_schema JSON (controlled). */
  variablesSchema: string;
  /** Sample values keyed by field name (controlled, drives the form inputs). */
  sampleValues: Record<string, string>;
  readOnly?: boolean;
  onTemplateTextChange: (next: string) => void;
  onSampleValuesChange: (next: Record<string, string>) => void;
}

export function VariableSchemaForm({
  copy,
  templateText,
  variablesSchema,
  sampleValues,
  readOnly = false,
  onTemplateTextChange,
  onSampleValuesChange,
}: VariableSchemaFormProps) {
  const fields = useMemo(
    () => deriveFields(variablesSchema, templateText),
    [variablesSchema, templateText],
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Seed any field that has no sample value yet so inputs are controlled.
  useEffect(() => {
    const missing = fields.filter((f) => !(f.name in sampleValues));
    if (missing.length > 0) {
      const next = { ...sampleValues };
      for (const f of missing) next[f.name] = '';
      onSampleValuesChange(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields]);

  const setField = (name: string, value: string) => {
    onSampleValuesChange({ ...sampleValues, [name]: value });
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="font-serif text-base font-semibold text-book-ink-primary">{copy.formHeading}</h3>
        <p className="mt-1 text-sm text-book-ink-muted">{copy.formHint}</p>
      </div>

      {fields.length === 0 ? (
        <p className="rounded-md border border-book-border bg-book-bg-secondary px-3 py-2 text-sm text-book-ink-muted">
          {copy.noFields}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map((field) => (
            <div
              key={field.name}
              className={
                field.type === 'text'
                  ? 'flex flex-col gap-1 sm:col-span-2'
                  : 'flex flex-col gap-1'
              }
            >
              <label className="flex items-baseline gap-2 text-sm font-medium text-book-ink-secondary">
                <span className="font-mono text-book-ink-primary">{field.label ?? field.name}</span>
                {field.required && <span className="text-book-danger">*</span>}
                <span className="font-mono text-xs text-book-ink-muted">{`{{${field.name}}}`}</span>
              </label>
              {field.description && (
                <p className="text-xs text-book-ink-muted">{field.description}</p>
              )}
              {field.type === 'text' ? (
                <Textarea
                  variant="boxed"
                  value={sampleValues[field.name] ?? ''}
                  onChange={(e) => setField(field.name, e.target.value)}
                  rows={3}
                  className="font-sans"
                />
              ) : (
                <Input
                  variant="boxed"
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={sampleValues[field.name] ?? ''}
                  onChange={(e) => setField(field.name, e.target.value)}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5 self-start px-2 text-book-ink-muted">
            {advancedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {copy.advancedToggle}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <label className="mb-1.5 block text-sm font-medium text-book-ink-secondary">
            {copy.rawTemplateLabel}
          </label>
          <Textarea
            value={templateText}
            onChange={(e) => onTemplateTextChange(e.target.value)}
            rows={12}
            readOnly={readOnly}
            className="font-mono text-xs leading-relaxed"
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
