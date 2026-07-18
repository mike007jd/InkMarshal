import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DesktopShell workspace-mode re-entry', () => {
  it('restores remembered modes from the sidebar and generic search results', () => {
    const shell = readFileSync(
      join(process.cwd(), 'components/DesktopShellLayout.tsx'),
      'utf8',
    );

    expect(shell).toContain('const rememberedNovelViews = useRememberedNovelViews()');
    expect(shell).toContain('buildNovelEntryHref(novelId, rememberedNovelViews[novelId])');
    expect(shell).toContain('buildNovelEntryHref(novel.id, rememberedNovelViews[novel.id])');
    expect(shell).toContain('view: \'read-edit\'');
  });
});
