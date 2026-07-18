import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('reading heat-zone UX', () => {
  it('keeps primary navigation compact and removes the old per-novel tab strip', () => {
    const novelTopBar = source('components/NovelTopBar.tsx');
    const novelWorkspace = source('components/NovelWorkspace.tsx');
    const knowledgePanel = source('components/knowledge/KnowledgePanel.tsx');
    const manuscriptReading = source('components/ManuscriptReadingView.tsx');

    expect(novelTopBar).not.toContain("from '@/components/ui/tabs'");
    expect(novelTopBar).not.toContain('TabsList');
    expect(novelTopBar).not.toContain('TabsTrigger');
    expect(novelTopBar).toContain('truncate text-left font-serif');
    // Mode tabs (Agent/Story Deck/Read·Edit) now live as a single segmented
    // control inside the compact top bar. The old vertical rail + mobile bar —
    // which each owned a separate band and wasted header + column space — were
    // removed; the top bar fills the previously-empty header and the content
    // column reclaims the rail's width.
    expect(novelTopBar).toContain("view: 'story-deck'");
    expect(novelTopBar).toContain('setView(itemView)');
    // The mode switcher is a <nav> of buttons (not an ARIA tabs widget — the
    // design-system contract forbids hand-rolled role="tab" and this file
    // forbids ui/tabs here). Lock its a11y wiring so it can't silently regress:
    // a labelled nav landmark + per-item current-state.
    expect(novelTopBar).toContain('aria-label={t.novelModeNav}');
    expect(novelTopBar).toContain("aria-current={active ? 'page' : undefined}");
    expect(novelWorkspace).not.toContain('function NovelModeRail');
    expect(novelWorkspace).not.toContain('function NovelModeMobileBar');
    expect(novelWorkspace).toContain('view={view}');
    expect(novelWorkspace).toContain('setView={selectView}');
    expect(novelWorkspace).toContain('lg:hidden');
    expect(novelWorkspace).toContain('function StoryDeckMode');
    expect(novelWorkspace).toContain('controlledFilter={tab}');
    expect(novelWorkspace).toContain('variant="deck"');
    expect(novelWorkspace).toContain("view === 'agent'");
    expect(novelWorkspace).toContain("view === 'story-deck'");
    expect(novelWorkspace).toContain("view === 'read-edit'");
    expect(novelWorkspace).not.toContain("view === 'command'");
    expect(novelWorkspace).not.toContain("view === 'inbox'");
    expect(novelWorkspace).not.toContain("view === 'publishing'");
    expect(manuscriptReading).toContain("from '@/components/ui/empty'");
    expect(manuscriptReading).toContain('p-10 text-left shadow-xl md:p-12');
    expect(manuscriptReading).not.toContain('px-10 py-14 text-center');
    expect(knowledgePanel).toContain("import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';");
    expect(knowledgePanel).toContain("variant = 'workspace'");
    expect(knowledgePanel).toContain("variant === 'deck'");
    // 2026-07-02 UI/UX audit: the deck grid became responsive multi-column
    // (md:2 / xl:3) so wide Story Deck panes tile cards instead of one giant
    // full-width card per row. Single column on mobile is preserved.
    expect(knowledgePanel).toContain("isDeck ? 'grid grid-cols-1 gap-3 pt-2 md:grid-cols-2 xl:grid-cols-3'");
    expect(knowledgePanel).not.toContain('overflow-x-auto');
    expect(knowledgePanel).not.toContain('role="tablist"');
  });

  it('anchors global workspace tools to the sidebar bottom-left, below the manuscript list', () => {
    const desktopShell = source('components/DesktopShellLayout.tsx');

    // Product owner reversed the earlier "cold zone" placement: Models/Settings
    // are app-level utilities and belong in a footer cluster pinned to the
    // sidebar floor (platform-standard), below the My Desk list which owns
    // flex-1. The top of the sidebar carries only the single New-novel CTA —
    // no redundant Install-LLM button stacked over the Models entry.
    expect(desktopShell).toContain('{t.workspaceTools}');
    expect(desktopShell).toContain('href="/desktop-studio/workflows"');
    expect(desktopShell).toContain('href="/desktop-studio/series"');
    expect(desktopShell).toContain('href="/desktop-studio/usage"');
    expect(desktopShell).toContain('mt-auto border-t border-book-border bg-book-bg-sidebar');
    expect(desktopShell.indexOf('{t.workspaceTools}')).toBeGreaterThan(
      desktopShell.indexOf('{t.yourProjects}'),
    );
    expect(desktopShell).not.toContain('{newNovelActionLabel}');
  });

  it('keeps the studio first-run path a single install card without the dead multi-step tracker', () => {
    const wizard = source('components/StudioFirstRunWizard.tsx');

    // The wizard only ever renders while no model is ready, so the old 3-step
    // tracker (steps 2/3 unreachable) was removed in favour of one install card.
    expect(wizard).not.toContain('md:grid-cols-[minmax(0,1fr)_4rem_minmax(0,1fr)_4rem_minmax(0,1fr)]');
    expect(wizard).not.toContain('currentStep');
    expect(wizard).not.toContain('firstRunStep2Title');
    expect(wizard).not.toContain('firstRunStep3Title');
    // Overflow-safety on the install card: heading wrapper and truncating rows.
    expect(wizard).toContain('mb-4 min-w-0');
    expect(wizard).toContain('truncate text-sm font-medium text-book-ink-primary');
  });

  it('uses a read timeout for every manuscript AI stream consumer', () => {
    // The AI stream consumers moved into hooks (Phase 4.1): toolbar generation
    // lives in useManuscriptGeneration and freeform edit-chat in useAIEditChat.
    // Every consumeNdjsonStream(res, …)
    // must still pin a read timeout so a hung provider can't wedge the spinner.
    const generation = source('hooks/useManuscriptGeneration.ts');
    const editChat = source('hooks/useAIEditChat.ts');
    const combined = generation + editChat;
    const streamCalls = combined.match(/consumeNdjsonStream\(res,/g) ?? [];

    expect(streamCalls).toHaveLength(2);
    expect(combined.match(/readTimeoutMs: WRITING_SESSION_READ_TIMEOUT_MS/g)).toHaveLength(2);
    expect(generation).toContain("const generationTimeoutMessage = t.generationTimedOut || 'Generation timed out");
    expect(editChat).toContain("const generationTimeoutMessage = t.generationTimedOut || 'Generation timed out");
  });

  it('keeps the manuscript empty state focused on the desktop writing flow', () => {
    const en = source('lib/i18n/en.ts');

    expect(en).toContain("manuscriptEmptyDesc: 'Start in Agent. Once the writing run creates chapters, they will appear here for reading and editing.'");
  });
});
