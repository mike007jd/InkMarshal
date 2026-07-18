import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('global manuscript search', () => {
  it('switches between current-book and all-book full-text results', () => {
    const dialog = source('components/search/GlobalSearchDialog.tsx');
    const shell = source('components/DesktopShellLayout.tsx');
    const workspace = source('components/NovelWorkspace.tsx');

    expect(dialog).toContain("const [mode, setMode] = useState<'current' | 'all'>");
    expect(dialog).toContain("fetch(`/api/novels/${item.novelId}/chapters`)");
    expect(dialog).toContain('results: await search(chapters, q)');
    expect(dialog).toContain('{t.searchCurrentNovel}');
    expect(dialog).toContain('{t.searchAllNovels}');
    expect(shell).toContain("search.set('offset', String(offset))");
    expect(workspace).toContain("searchParams?.get('offset')");
  });
});
