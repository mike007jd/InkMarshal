import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('visible affordances stay honest', () => {
  it('uses real Settings tabs instead of a scroll-spy nav that can show the wrong panel', () => {
    const settings = source('components/SettingsPanel.tsx');

    expect(settings).not.toContain('<TabsContent value="runtime"');
    expect(settings).toContain('<TabsContent value="writing"');
    expect(settings).toContain('<TabsContent value="vault"');
    expect(settings).toContain('<VaultSettings novelId={activeNovelId} />');
    expect(settings).toContain("initialSection === 'vault' && (!hasNovelContext || !getSettings().developerTools)");
    expect(settings).toContain("import { ScrollArea } from '@/components/ui/scroll-area';");
    expect(settings).toContain("} from '@/components/ui/sheet';");
    expect(settings).toContain("import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';");
    expect(settings).toContain('onValueChange={v => setActiveSection(normalizeSettingsSection(v))}');
    expect(settings).toContain('orientation="vertical"');
    expect(settings).toContain('flex h-full w-full flex-col');
    expect(settings).toContain('grid-cols-[10.5rem_1px_minmax(0,1fr)]');
    expect(settings).toContain('data-[state=on]:border-book-gold');
    expect(settings).not.toContain('data-settings-section=');
    expect(settings).not.toContain('scrollTo({');
    expect(settings).not.toContain('overflow-x-auto');
    expect(settings).not.toContain('overflow-y-auto');
    expect(settings).not.toContain('grid h-14 w-full grid-cols-4');
    expect(settings).not.toContain('grid-cols-2');
  });

  it('keeps the desktop studio free of full-screen web example drafts (no dead-end demo)', () => {
    const studio = source('components/DesktopStudioShell.tsx');

    // Desktop users must never be dropped into the web-only /examples reader,
    // which has only a "Download App" CTA and no way back into the studio.
    expect(studio).not.toContain('/examples/');
    expect(studio).not.toContain('EXAMPLE_NOVELS');
    expect(studio).not.toContain('firstRunPrereqExampleDisabled');
  });
});
