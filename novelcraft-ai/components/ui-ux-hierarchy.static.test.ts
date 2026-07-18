import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('UI/UX hierarchy contracts', () => {
  it('keeps low-frequency global tools discoverable but collapsed', () => {
    const shell = source('components/DesktopShellLayout.tsx');
    expect(shell).toContain('<Collapsible>');
    expect(shell).toContain('{t.moreTools}');
    expect(shell.indexOf('{t.settings}')).toBeLessThan(shell.indexOf('href="/desktop-studio/workflows"'));
    expect(shell).toContain("router.push('/desktop-studio/models')");
  });

  it('keeps edit-chat options progressive and removes the abandoned variants chain', () => {
    const chatbox = source('components/EditChatbox.tsx');
    const editing = source('components/ManuscriptEditingView.tsx');
    const generation = source('hooks/useManuscriptGeneration.ts');
    expect(chatbox).toContain('<Popover>');
    expect(chatbox).toContain('syncFailed={creativitySyncFailed}');
    expect(chatbox).not.toContain('onVariantsChange');
    expect(editing).not.toContain('VariantPicker');
    expect(generation).not.toContain('rewrite-variants');
    expect(editing).toContain('creativitySyncFailed={creativitySyncFailed}');
  });

  it('requires confirmation before applying every unification edit', () => {
    const panel = source('components/UnificationPanel.tsx');
    expect(panel).toContain('onClick={() => setConfirmAllOpen(true)}');
    expect(panel).toContain('<Dialog open={confirmAllOpen}');
    expect(panel).toContain("void apply('all')");
    expect(panel).not.toContain("onClick={() => apply('all')}");
  });

  it('keeps engineering usage metrics collapsed and exposes no fake telemetry switch', () => {
    const usage = source('components/studio/usage-panel.tsx');
    const copy = source('components/studio/usage-panel-copy.ts');
    expect(usage).toContain('<Collapsible className=');
    expect(usage).toContain('{t.advancedDiagnostics}');
    expect(usage).toContain("row.connectionKind !== 'local'");
    expect(usage).toContain("row.connectionKind === 'local'");
    expect(usage).toContain('i === bestValueIndex');
    expect(usage).not.toContain('i === 0 && <Badge variant="gold"');
    expect(copy).toContain('不虚构成省下的金额');
    expect(copy).not.toContain('本地引擎为 $0');
    expect(usage).not.toContain('TELEMETRY_KEY');
    expect(usage).not.toContain('telemetryOptIn');
  });

  it('keeps responsive drawers keyboard-safe and closes them on wide resize', () => {
    const workspace = source('components/NovelWorkspace.tsx');
    const manuscript = source('components/ManuscriptShell.tsx');
    const sidebar = source('components/ManuscriptSidebar.tsx');
    expect(workspace).toContain("window.matchMedia('(min-width: 1024px)')");
    expect(manuscript).toContain("window.matchMedia('(min-width: 1024px)')");
    expect(manuscript).toContain('aria-label={t.manuscriptChapters}');
    expect(sidebar).toContain('variant="unstyled"');
    expect(sidebar).toContain("aria-current={isActive ? 'true' : undefined}");
    expect(sidebar).toContain('onClick={() => onChapterSelect(ch.chapterNumber)}');
  });
});
