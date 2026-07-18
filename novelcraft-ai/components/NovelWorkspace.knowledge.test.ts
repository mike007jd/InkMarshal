import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('NovelWorkspace knowledge outline wiring', () => {
  it('keeps knowledge out of the top-level novel modes', () => {
    const workspace = source('components/NovelWorkspace.tsx');

    expect(workspace).not.toContain("from '@/components/KnowledgeWorkspace'");
    expect(workspace).not.toContain("setKnowledgeSubView('outline')");
    expect(workspace).not.toContain('subView={knowledgeSubView}');
    expect(workspace).toContain('function AgentMode');
    expect(workspace).toContain('function StoryDeckMode');
    // Mode switching moved into the top bar's segmented tabs; the standalone
    // vertical rail and mobile bar were removed.
    expect(workspace).not.toContain('function NovelModeMobileBar');
    expect(workspace).not.toContain('function NovelModeRail');
    expect(workspace).toContain('<NovelTopBar');
    expect(workspace).toContain('setView={selectView}');
    expect(workspace).toContain('rememberNovelWorkspaceView(novelId, nextView)');
    expect(workspace).toContain('rememberNovelWorkspaceViewAfterHydration(novelId, viewFromUrl ?? initialView)');
    expect(workspace).toContain('window.history.replaceState(null, \'\', nextHref)');
    expect(workspace).toContain("from '@/components/knowledge/KnowledgePanel'");
    expect(workspace).toContain('controlledFilter={tab}');
    expect(workspace).toContain('function ManuscriptPaneBody');
  });

  it('routes Edit blueprint to the Story Deck outline instead of Brainstorm', () => {
    const workspace = source('components/NovelWorkspace.tsx');

    expect(workspace).toContain("const [storyDeckTab, setStoryDeckTab] = useState<KnowledgeFilterTab>('character')");
    expect(workspace).toContain("setStoryDeckTab('outline');");
    expect(workspace).toContain("selectView('story-deck');");
    expect(workspace).not.toContain("onJumpToOutline={() => selectView('agent')}");
  });

  it('keeps brainstorming first while exposing story and manuscript as first-class modes', () => {
    const workspace = source('components/NovelWorkspace.tsx');
    const novelTopBar = source('components/NovelTopBar.tsx');
    const studio = source('components/DesktopStudioShell.tsx');
    const manuscript = source('components/ManuscriptShell.tsx');
    const en = source('lib/i18n/en.ts');
    const zhCN = source('lib/i18n/zh-CN.ts');

    expect(workspace).toContain('const PRE_WRITING_STAGES');
    expect(workspace).toContain('conversationThreadsUnlocked={conversationThreadsUnlocked}');
    // Story Deck is a first-class mode surfaced by the top-bar segmented tabs.
    expect(novelTopBar).toContain("view: 'story-deck'");
    expect(workspace).toContain("view === 'story-deck'");
    expect(workspace).toContain('function StoryDeckMode');
    expect(studio).toContain('openingAssistantMessage: t.agentOpeningMessage');
    expect(studio).toContain('`/novel/${novel.id}?view=agent`');
    expect(studio).toContain('`/novel/${novel.id}?view=read-edit&chapter=1&edit=1`');
    expect(workspace).toContain("const startInEditing = searchParams?.get('edit') === '1';");
    expect(workspace).toContain('startInEditing={startInEditing}');
    expect(manuscript).toContain("startInEditing && !readOnly ? 'editing' : 'reading'");
    expect(studio).toContain('<ImportManuscriptEntry');
    expect(en).toContain("agentMainThread: 'Brainstorm'");
    expect(en).toContain("storyDeckMode: 'Story'");
    expect(en).toContain("readEditMode: 'Manuscript'");
    expect(workspace).toContain('{t.agentThreads}');
    expect(workspace).toContain('setMobileThreadsOpen(true)');
    expect(zhCN).toContain("storyDeckWorld: '世界观'");
    expect(zhCN).toContain("agentMainThread: '构思'");
  });

  it('keeps Brainstorm on the assistant-ui thread instead of the fixed interview form', () => {
    const chatArea = source('components/ChatArea.tsx');

    expect(chatArea).toContain('<AssistantRuntimeProvider runtime={runtime}>');
    expect(chatArea).toContain("autoStartLastUserTurn: searchParams.get('autostart') === '1'");
    expect(chatArea).toContain('<NovelThread');
    expect(chatArea).not.toContain('InterviewComposer');
    expect(chatArea).not.toContain('/interview');
  });

  it('refreshes both novel copies when Brainstorm advances the stage', () => {
    const workspace = source('components/NovelWorkspace.tsx');

    expect(workspace).toContain('const handleAgentTurnComplete = useCallback(() => {');
    expect(workspace).toContain('refreshNovel()');
    expect(workspace).toContain('fetchManuscriptNovel()');
    expect(workspace).toContain('onUpdate={handleAgentTurnComplete}');
  });

  it('preserves outline chapter deep-links into the manuscript shell', () => {
    const workspace = source('components/NovelWorkspace.tsx');
    const shell = source('components/ManuscriptShell.tsx');

    expect(workspace).toContain("searchParams?.get('chapter')");
    expect(workspace).toContain('requestedChapter={chapterFromUrl}');
    expect(workspace).toContain('requestedChapter?: number | null');
    expect(shell).toContain('requestedChapter?: number | null');
    expect(shell).toContain('appliedRequestedChapterKeyRef');
    expect(shell).toContain('setActiveChapter(requestedChapter)');
  });

  it('invalidates stale style extraction when the sample text changes mid-request', () => {
    const form = source('components/knowledge/KnowledgeEntryForm.tsx');

    expect(form).toContain('const sampleTextRef = useRef(sampleText)');
    expect(form).toContain('sampleTextRef.current = sampleText');
    expect(form).toContain('}, [scopeKey, sampleText])');
    expect(form).toContain('requestSample !== sampleTextRef.current');
  });
});
