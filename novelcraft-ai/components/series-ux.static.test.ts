import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('series authoring UX', () => {
  it('requires a deliberate series name instead of creating an untitled shell', () => {
    const page = source('app/desktop-studio/series/page.tsx');
    const actions = source('app/actions/series.ts');

    expect(page).toContain('disabled={creating || !draftTitle.trim()}');
    expect(actions).toContain("if (!title) throw new Error('Series title is required')");
    expect(actions).not.toContain("|| 'Untitled Series'");
  });

  it('names affected books, shows overrides, and suggests conflict resolution without auto-rewriting', () => {
    const workspace = source('components/studio/series-workspace.tsx');

    expect(workspace).toContain('{t.affectedBooks}:');
    expect(workspace).toContain('{t.overrideDifferences}');
    expect(workspace).toContain('{suggestion(c.kind)}');
    expect(workspace).not.toContain('autoResolveConflict');
  });
});
