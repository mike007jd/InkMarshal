// Server-only prompt template resolver.
//
// The baseline `prompt_templates` SQLite table stores the active text for every
// (stage, role, locale, variant) combination.
// `getPromptTemplate` first looks up the requested variant across the locale
// fallback chain (zh-TW → zh-CN → en). When that variant has no row anywhere,
// it repeats the same locale chain for `default`.
//
// Templates use Mustache-style `{{var}}` placeholders. `renderTemplate`
// substitutes them; missing variables raise TemplateRenderError so the bug
// surfaces during testing rather than as a stringified `[object Object]`
// reaching a user.

import { getDb } from '@/lib/db/connection';
import type { Locale } from '@/lib/i18n';

export type PromptRole = 'user' | 'system';

export interface PromptTemplateQuery {
  stage: string;
  role: PromptRole;
  locale: Locale;
  variant?: string;
}

export interface PromptTemplateRecord {
  id: string;
  stage: string;
  role: PromptRole;
  locale: Locale;
  version: number;
  variant: string;
  templateText: string;
  variablesSchema: string;
}

export class TemplateNotFoundError extends Error {
  constructor(
    public readonly query: PromptTemplateQuery,
    public readonly triedLocales: Locale[],
  ) {
    super(
      `prompt template not found for stage="${query.stage}" role="${query.role}" variant="${query.variant ?? 'default'}" (tried locales: ${triedLocales.join(', ')})`,
    );
    this.name = 'TemplateNotFoundError';
  }
}

class TemplateRenderError extends Error {
  constructor(public readonly missing: string[]) {
    super(`template render: missing variables: ${missing.join(', ')}`);
    this.name = 'TemplateRenderError';
  }
}

const LOCALE_FALLBACK_CHAIN: Record<Locale, Locale[]> = {
  en: ['en'],
  'zh-CN': ['zh-CN', 'en'],
  'zh-TW': ['zh-TW', 'zh-CN', 'en'],
};

function lookupOne(
  stage: string,
  role: PromptRole,
  locale: Locale,
  variant: string,
): PromptTemplateRecord | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, stage, role, locale, version, variant, template_text, variables_schema
         FROM prompt_templates
        WHERE stage = ? AND role = ? AND locale = ? AND variant = ? AND active = 1
        ORDER BY version DESC
        LIMIT 1`,
    )
    .get(stage, role, locale, variant) as
    | {
        id: string;
        stage: string;
        role: PromptRole;
        locale: Locale;
        version: number;
        variant: string;
        template_text: string;
        variables_schema: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    stage: row.stage,
    role: row.role,
    locale: row.locale,
    version: row.version,
    variant: row.variant,
    templateText: row.template_text,
    variablesSchema: row.variables_schema,
  };
}

export function getPromptTemplate(query: PromptTemplateQuery): PromptTemplateRecord {
  const variant = query.variant ?? 'default';
  const chain = LOCALE_FALLBACK_CHAIN[query.locale] ?? ['en'];
  for (const locale of chain) {
    const found = lookupOne(query.stage, query.role, locale, variant);
    if (found) return found;
  }
  if (variant !== 'default') {
    for (const locale of chain) {
      const found = lookupOne(query.stage, query.role, locale, 'default');
      if (found) return found;
    }
  }
  throw new TemplateNotFoundError(query, chain);
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function lookupPath(vars: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, vars);
}

export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  const missing: string[] = [];
  const rendered = template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const value = lookupPath(vars, name);
    if (value === undefined || value === null) {
      missing.push(name);
      return '';
    }
    return String(value);
  });
  if (missing.length > 0) {
    throw new TemplateRenderError(Array.from(new Set(missing)));
  }
  return rendered;
}
